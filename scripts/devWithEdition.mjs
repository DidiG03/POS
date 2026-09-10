import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const edition =
  String(process.argv[2] || '')
    .trim()
    .toUpperCase() === 'STORE'
    ? 'STORE'
    : 'RESTAURANT';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn('pnpm', ['run', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, POS_EDITION: edition },
  shell: true,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
