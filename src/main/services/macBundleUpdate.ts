import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MacSignatureKind = 'developer-id' | 'adhoc' | 'unsigned';

/** Squirrel.Mac only installs a zip signed with the same Developer ID. */
export function classifyMacSignature(codesignText: string): MacSignatureKind {
  const text = String(codesignText || '');
  if (/Developer ID Application/.test(text)) return 'developer-id';
  if (/Signature=adhoc|\(adhoc\)|flags=0x2/.test(text)) return 'adhoc';
  return 'unsigned';
}

export function macBundlePathFromExec(execPath: string): string | null {
  const bundle = path.resolve(execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

export function updaterCacheDirNameFromYml(yml: string): string | null {
  const match = String(yml || '').match(
    /^updaterCacheDirName:\s*['"]?([^'"\n#]+)['"]?\s*$/m,
  );
  const name = match?.[1]?.trim();
  return name || null;
}

export function pendingUpdateZip(
  pendingDir: string,
  updateInfoJson: string,
): string | null {
  let fileName = '';
  try {
    const parsed = JSON.parse(updateInfoJson) as { fileName?: unknown };
    fileName = String(parsed?.fileName || '');
  } catch {
    return null;
  }
  if (!fileName || path.isAbsolute(fileName) || fileName.includes('..')) {
    return null;
  }
  if (!fileName.toLowerCase().endsWith('.zip')) return null;
  return path.join(pendingDir, fileName);
}

/**
 * Replaces the running .app with the downloaded one once this process exits.
 *
 * The till is the LAN server for every tablet, so the one rule that matters
 * is that the app always comes back: whatever step fails, the EXIT trap puts
 * the previous bundle back if the swap stopped half way and reopens it.
 *
 * The bundle is only replaced by an app with the same CFBundleIdentifier, so
 * a wrong or tampered archive is refused rather than installed.
 * electron-updater has already checked the zip's sha512 against the release
 * feed before it lands in `pending/`.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/bash
set -uo pipefail
pid="$1"
bundle="$2"
zip="$3"
parent=$(dirname "$bundle")
base=$(basename "$bundle")
stage="$parent/.$base.update"
backup="$parent/.$base.previous"
work=""

finish() {
  status=$?
  if [[ -n "$work" ]]; then rm -rf "$work"; fi
  rm -rf "$stage"
  if [[ ! -d "$bundle" && -d "$backup" ]]; then
    mv "$backup" "$bundle" || true
  fi
  if [[ -d "$bundle" ]]; then rm -rf "$backup"; fi
  open "$bundle" || true
  exit "$status"
}
trap finish EXIT

waited=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 0.2
  waited=$((waited + 1))
  if (( waited > 600 )); then
    exit 1
  fi
done
sleep 0.5

work=$(mktemp -d) || exit 1
ditto -x -k "$zip" "$work" || exit 1
new_app=$(find "$work" -maxdepth 3 -name '*.app' -print -quit)
if [[ -z "\${new_app}" ]]; then
  exit 1
fi
plist_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null
}
old_id=$(plist_id "$bundle" || true)
new_id=$(plist_id "$new_app" || true)
if [[ -z "$old_id" || "$old_id" != "$new_id" ]]; then
  exit 1
fi
xattr -dr com.apple.quarantine "$new_app" 2>/dev/null || true
rm -rf "$stage"
ditto "$new_app" "$stage" || exit 1
rm -rf "$backup"
mv "$bundle" "$backup" || exit 1
mv "$stage" "$bundle" || exit 1
exit 0
`;

/**
 * True when this macOS user can move the bundle out of its folder and put a
 * new one in. Checked before quitting: without it the swap fails after the
 * till has already shut down.
 */
export function canReplaceMacBundle(bundlePath: string): boolean {
  try {
    fs.accessSync(path.dirname(bundlePath), fs.constants.W_OK);
    fs.accessSync(bundlePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function readMacSignatureKind(bundlePath: string): MacSignatureKind {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', bundlePath], {
    encoding: 'utf8',
  });
  return classifyMacSignature(`${result.stdout || ''}\n${result.stderr || ''}`);
}

export function launchMacBundleSwap(input: {
  pid: number;
  bundlePath: string;
  zipPath: string;
}): void {
  const scriptPath = path.join(
    os.tmpdir(),
    `onetap-mac-update-${input.pid}.sh`,
  );
  fs.writeFileSync(scriptPath, MAC_SWAP_SCRIPT, { mode: 0o700 });
  const child = spawn(
    '/bin/bash',
    [scriptPath, String(input.pid), input.bundlePath, input.zipPath],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}
