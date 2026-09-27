import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAC_SWAP_SCRIPT,
  canReplaceMacBundle,
  classifyMacSignature,
  macBundlePathFromExec,
  pendingUpdateZip,
  updaterCacheDirNameFromYml,
} from './macBundleUpdate';

describe('mac bundle update', () => {
  it('treats a Developer ID as the signature Squirrel can install', () => {
    expect(
      classifyMacSignature(
        'Authority=Developer ID Application: OneTap (ABC)\nSignature=adhoc',
      ),
    ).toBe('developer-id');
    expect(classifyMacSignature('Signature=adhoc\nflags=0x2(adhoc)')).toBe(
      'adhoc',
    );
    expect(classifyMacSignature('code object is not signed at all')).toBe(
      'unsigned',
    );
  });

  it('finds the .app that contains the running executable', () => {
    expect(
      macBundlePathFromExec(
        '/Applications/OneTap POS.app/Contents/MacOS/OneTap POS',
      ),
    ).toBe('/Applications/OneTap POS.app');
    expect(macBundlePathFromExec('/usr/local/bin/onetap')).toBeNull();
  });

  it('reads the updater cache name electron-builder writes', () => {
    expect(
      updaterCacheDirNameFromYml(
        'owner: DidiG03\nupdaterCacheDirName: code-orbit-pos-updater\n',
      ),
    ).toBe('code-orbit-pos-updater');
  });

  it('accepts only a zip file name inside the pending folder', () => {
    const dir = path.join('/tmp', 'pending');
    expect(
      pendingUpdateZip(
        dir,
        JSON.stringify({ fileName: 'OneTap-POS-0.2.70-arm64.zip' }),
      ),
    ).toBe(path.join(dir, 'OneTap-POS-0.2.70-arm64.zip'));
    expect(
      pendingUpdateZip(dir, JSON.stringify({ fileName: '../secret.zip' })),
    ).toBeNull();
    expect(
      pendingUpdateZip(
        dir,
        JSON.stringify({ fileName: 'OneTap-POS-0.2.70-arm64.dmg' }),
      ),
    ).toBeNull();
  });

  it('swaps the bundle only after this process has exited', () => {
    expect(MAC_SWAP_SCRIPT).toContain('while kill -0 "$pid"');
    expect(MAC_SWAP_SCRIPT).toContain('ditto -x -k "$zip"');
    expect(MAC_SWAP_SCRIPT).toContain('open "$bundle"');
  });

  it('always reopens the till, putting the old app back if the swap stopped', () => {
    // The reopen lives in the EXIT trap, so every failed step still runs it.
    expect(MAC_SWAP_SCRIPT).toContain('trap finish EXIT');
    const finish = MAC_SWAP_SCRIPT.slice(
      MAC_SWAP_SCRIPT.indexOf('finish() {'),
      MAC_SWAP_SCRIPT.indexOf('trap finish EXIT'),
    );
    expect(finish).toContain('mv "$backup" "$bundle"');
    expect(finish).toContain('open "$bundle"');
    expect(MAC_SWAP_SCRIPT).not.toContain('set -e');
  });

  it('only installs an app with the same bundle identifier', () => {
    expect(MAC_SWAP_SCRIPT).toContain('CFBundleIdentifier');
    expect(MAC_SWAP_SCRIPT).toContain('"$old_id" != "$new_id"');
  });

  it('refuses to swap a bundle this user cannot replace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macswap-'));
    const bundle = path.join(dir, 'OneTap POS.app');
    fs.mkdirSync(bundle);
    try {
      expect(canReplaceMacBundle(bundle)).toBe(true);
      fs.chmodSync(dir, 0o555);
      expect(canReplaceMacBundle(bundle)).toBe(false);
      expect(canReplaceMacBundle(path.join(dir, 'missing.app'))).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
