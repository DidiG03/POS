/**
 * Run the Capacitor CLI against the OneTap Admin iOS project.
 *
 * Capacitor 8 has no `--config` flag, so we set `CAP_APP=admin` and let
 * `capacitor.config.ts` swap in `capacitor.admin.config.ts`.
 *
 * Always pass a platform (usually `ios`) so the CLI never tries to sync
 * unused `android-admin`.
 *
 *   node scripts/capAdmin.mjs sync ios
 *   node scripts/capAdmin.mjs open ios
 *   node scripts/capAdmin.mjs run ios
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capBin = path.join(
  root,
  'node_modules',
  '@capacitor',
  'cli',
  'bin',
  'capacitor',
);

process.env.CAP_APP = 'admin';

const child = spawn(process.execPath, [capBin, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
