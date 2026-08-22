/**
 * Cross-check the IPC policy table against where the renderer actually calls
 * each channel.
 *
 * A policy that denies a call the UI legitimately makes is a service outage, so
 * this walks the preload bridge to map `api.<ns>.<method>` onto channel names,
 * finds every renderer file that calls each one, and prints the result grouped
 * by how restrictive the policy is. Reviewing the "public" and "restricted"
 * sections against the route guards in `src/renderer/routes.tsx` is what
 * catches a channel gated tighter than the screen that uses it.
 *
 * Usage: pnpm tsx scripts/auditIpcPolicy.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_POLICIES } from '../src/main/services/ipcPolicy';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'index.ts');
const RENDERER = path.join(ROOT, 'src', 'renderer');

/**
 * Map each channel to the preload method that invokes it.
 *
 * The preload is written in several styles (inline arrows, multi-line arrows,
 * async shorthand), so instead of parsing its structure we collapse whitespace
 * and pick out `name: ... ipcRenderer.invoke('channel')` pairs. Bridge methods
 * are conventionally named after the channel suffix, which is the fallback when
 * a pair can't be read directly.
 */
function channelToMethodNames(): Map<string, Set<string>> {
  const flat = fs.readFileSync(PRELOAD, 'utf8').replace(/\s+/g, ' ');
  const byChannel = new Map<string, Set<string>>();
  const add = (channel: string, method: string) => {
    if (!byChannel.has(channel)) byChannel.set(channel, new Set());
    byChannel.get(channel)!.add(method);
  };

  const re =
    /(\w+)\s*[:(][^;]{0,160}?ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) add(m[2], m[1]);

  for (const channel of Object.keys(IPC_POLICIES)) {
    const suffix = channel.split(':')[1];
    if (suffix) add(channel, suffix);
  }
  return byChannel;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name))
      out.push(full);
  }
  return out;
}

function main(): void {
  const methodsByChannel = channelToMethodNames();
  const callers = new Map<string, Set<string>>();

  for (const file of walk(RENDERER)) {
    // main.tsx defines the HTTP shim, so its `api.x.y` mentions are
    // declarations rather than call sites.
    if (file.endsWith(path.join('renderer', 'main.tsx'))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const [channel, methods] of methodsByChannel) {
      const ns = channel.split(':')[0];
      const hit = [...methods].some((fn) =>
        new RegExp(`\\bapi\\.${ns}\\.${fn}\\s*\\(`).test(src),
      );
      if (!hit) continue;
      if (!callers.has(channel)) callers.set(channel, new Set());
      callers.get(channel)!.add(rel);
    }
  }

  const rows = Object.entries(IPC_POLICIES).map(([channel, policy]) => ({
    channel,
    allow: Array.isArray(policy.allow) ? policy.allow.join(',') : policy.allow,
    windows: policy.windows?.join(',') ?? '',
    callers: [...(callers.get(channel) ?? [])].sort(),
  }));

  const sections: Array<[string, typeof rows]> = [
    ['PUBLIC (reachable with no session)', rows.filter((r) => r.allow === 'public')],
    ['SESSION (any authenticated user)', rows.filter((r) => r.allow === 'session')],
    ['ROLE-RESTRICTED', rows.filter((r) => r.allow !== 'public' && r.allow !== 'session')],
  ];

  for (const [title, group] of sections) {
    console.log(`\n=== ${title} — ${group.length} channels ===`);
    for (const r of group) {
      const win = r.windows ? `  [+windows: ${r.windows}]` : '';
      console.log(`\n  ${r.channel}  (${r.allow})${win}`);
      if (r.callers.length === 0) console.log('    (no renderer caller found)');
      for (const c of r.callers) console.log(`    ${c}`);
    }
  }

  const uncalled = rows.filter((r) => r.callers.length === 0).map((r) => r.channel);
  console.log(`\n=== SUMMARY ===`);
  console.log(`channels: ${rows.length}`);
  console.log(`without a detected renderer caller: ${uncalled.length}`);
}

main();
