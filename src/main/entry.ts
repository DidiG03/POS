import { app } from 'electron';
import path from 'node:path';
import Module from 'node:module';
import fs from 'node:fs';

/**
 * Electron + Prisma + pnpm packaging fix.
 *
 * Prisma's `@prisma/client` expects to be able to `require(".prisma/client/default")`.
 * With pnpm + Electron packaging, `.prisma` is frequently not present inside `app.asar`,
 * so we ship it via `extraResources` and add that unpacked node_modules folder to
 * Node's module resolution paths before loading the rest of the app.
 */
function ensurePrismaModulePath() {
  try {
    if (!app.isPackaged) return;
    const unpackedNodeModules = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
    );
    const current = String(process.env.NODE_PATH || '').trim();
    const parts = current ? current.split(path.delimiter).filter(Boolean) : [];
    if (!parts.includes(unpackedNodeModules)) {
      process.env.NODE_PATH = [unpackedNodeModules, ...parts].join(
        path.delimiter,
      );
      // Recompute Node's global search paths.
      Module._initPaths();
    }
  } catch {
    // ignore (best-effort)
  }
}

/**
 * Ensure the packaged app always has a writable SQLite database.
 *
 * In dev, `.env` provides DATABASE_URL (usually `file:./dev.db`).
 * In packaged builds, `.env` is not shipped, and relative `file:./...` paths are unreliable.
 *
 * Strategy:
 * - Set DATABASE_URL to `<userData>/db/pos.db` when packaged
 * - On first run, copy a pre-migrated `seed.db` from `resources/seed.db`
 */
function ensureSqliteDbFile() {
  try {
    if (!app.isPackaged) return;

    const current = String(process.env.DATABASE_URL || '').trim();
    const looksRelative =
      current.startsWith('file:./') ||
      current.startsWith('file:../') ||
      current === 'file:./dev.db';

    if (current && !looksRelative) return;

    const userData = app.getPath('userData');
    const dbDir = path.join(userData, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const targetFile = path.join(dbDir, 'pos.db');

    if (!fs.existsSync(targetFile)) {
      const seedFile = path.join(process.resourcesPath, 'seed.db');
      if (fs.existsSync(seedFile)) {
        try {
          fs.copyFileSync(seedFile, targetFile);
        } catch {
          // fallback: create an empty file
          fs.writeFileSync(targetFile, '');
        }
      } else {
        fs.writeFileSync(targetFile, '');
      }
    }

    // Prisma prefers forward slashes in file URLs (esp. on Windows).
    process.env.DATABASE_URL = `file:${targetFile.split(path.sep).join('/')}`;
  } catch {
    // ignore (best-effort)
  }
}

function ensurePackagedDefaults() {
  try {
    if (!app.isPackaged) return;
    // Packaged builds do not ship `.env`, so default important toggles here.
    if (!String(process.env.ENABLE_ADMIN || '').trim()) {
      process.env.ENABLE_ADMIN = 'true';
    }
    // Force cloud onboarding even when env isn't configured.
    // The backend URL itself is not sensitive; secrets remain the Business password + tokens.
    if (!String(process.env.POS_CLOUD_URL || '').trim()) {
      process.env.POS_CLOUD_URL =
        'https://pos-api-1075917751068.europe-west1.run.app';
    }
    // Auto-updates: GitHub Releases source.
    if (!String(process.env.GITHUB_OWNER || '').trim()) {
      process.env.GITHUB_OWNER = 'DidiG03';
    }
    if (!String(process.env.GITHUB_REPO || '').trim()) {
      process.env.GITHUB_REPO = 'POS';
    }
  } catch {
    // ignore
  }
}

ensurePackagedDefaults();
ensureSqliteDbFile();
ensurePrismaModulePath();

// Load the actual app after path fix.
await import('./index');
