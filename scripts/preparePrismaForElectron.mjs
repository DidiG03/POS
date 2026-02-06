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

function isGeneratedPrismaDir(prismaDir) {
  // Prisma generates JS entrypoints like:
  //   .prisma/client/default.js
  // plus engine binaries in the same folder.
  return (
    exists(prismaDir) &&
    (exists(path.join(prismaDir, 'client', 'default.js')) ||
      exists(path.join(prismaDir, 'client', 'index.js')) ||
      exists(path.join(prismaDir, 'client', 'default.d.ts')))
  );
}

function findPrismaDirInPnpmStore(rootDir) {
  const pnpmDir = path.join(rootDir, 'node_modules', '.pnpm');
  if (!exists(pnpmDir)) return null;

  const entries = fs.readdirSync(pnpmDir);

  // Prefer the @prisma/client entry (most reliable).
  const preferred = entries.filter((n) => n.startsWith('@prisma+client@'));
  for (const e of preferred) {
    const candidate = path.join(pnpmDir, e, 'node_modules', '.prisma');
    if (isGeneratedPrismaDir(candidate)) return candidate;
  }

  // Fallback: any entry that has a generated .prisma/client.
  for (const e of entries) {
    const candidate = path.join(pnpmDir, e, 'node_modules', '.prisma');
    if (isGeneratedPrismaDir(candidate)) return candidate;
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
const destOk = isGeneratedPrismaDir(dest);

const src = findPrismaDirInPnpmStore(ROOT);
if (!src) {
  console.error('[prisma] Could not find generated .prisma directory under pnpm store. Did you run `pnpm db:generate`?');
  process.exit(1);
}

if (destOk) {
  console.log('[prisma] node_modules/.prisma already looks complete. Refreshing anyway to ensure Electron packaging includes it.');
}

console.log(`[prisma] Copying ${src} -> ${dest}`);
copyDir(src, dest);
console.log('[prisma] Done.');

