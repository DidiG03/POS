import { app } from 'electron';
import path from 'node:path';
import Module from 'node:module';

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

ensurePrismaModulePath();

// Load the actual app after path fix.
await import('./index');
