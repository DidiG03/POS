import fs from 'node:fs';
import path from 'node:path';

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findPrismaDirInPnpmStore(rootDir) {
  const pnpmDir = path.join(rootDir, 'node_modules', '.pnpm');
  if (!exists(pnpmDir)) return null;
  const entries = fs.readdirSync(pnpmDir).filter((n) => n.startsWith('@prisma+client@'));
  for (const e of entries) {
    const candidate = path.join(pnpmDir, e, 'node_modules', '.prisma');
    if (exists(candidate)) return candidate;
  }
  return null;
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

const ROOT = process.cwd();
const dest = path.join(ROOT, 'node_modules', '.prisma');

if (exists(dest)) {
  console.log('[prisma] node_modules/.prisma already exists, skipping.');
  process.exit(0);
}

const src = findPrismaDirInPnpmStore(ROOT);
if (!src) {
  console.error('[prisma] Could not find generated .prisma directory under pnpm store. Did you run `pnpm db:generate`?');
  process.exit(1);
}

console.log(`[prisma] Copying ${src} -> ${dest}`);
copyDir(src, dest);
console.log('[prisma] Done.');

