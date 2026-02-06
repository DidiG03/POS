import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

const ROOT = process.cwd();
const outDir = path.join(ROOT, 'build-resources');
const outFile = path.join(outDir, 'seed.db');

fs.mkdirSync(outDir, { recursive: true });
try {
  fs.rmSync(outFile, { force: true });
} catch {
  // ignore
}

// IMPORTANT:
// - We intentionally DO NOT rely on repo `.env` for the seed DB.
// - We set DATABASE_URL explicitly so the output is deterministic.
const env = {
  ...process.env,
  DATABASE_URL: `file:${outFile.split(path.sep).join('/')}`,
};

console.log(`[seed-db] Creating seeded SQLite DB at ${outFile}`);

// Apply migrations into the seed file.
run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env });

// Seed with a minimal default dataset (Admin 1234 + sample menu).
run('pnpm', ['db:seed'], { env });

console.log('[seed-db] Done.');

