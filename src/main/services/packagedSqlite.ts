import fs from 'node:fs';
import path from 'node:path';

/** SQLite live files that must move together when adopting a leftover DB. */
export function sqliteFileGroup(dbFile: string): string[] {
  return [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
}

export function copySqliteGroup(srcDb: string, destDb: string): void {
  fs.mkdirSync(path.dirname(destDb), { recursive: true });
  for (const src of sqliteFileGroup(srcDb)) {
    if (!fs.existsSync(src)) continue;
    const dest = src === srcDb ? destDb : destDb + src.slice(srcDb.length);
    fs.copyFileSync(src, dest);
  }
}

export function filesLookIdentical(
  a: string,
  b: string,
  exists: (file: string) => boolean = fs.existsSync,
  sizeOf: (file: string) => number = (file) => fs.statSync(file).size,
): boolean {
  if (!exists(a) || !exists(b)) return false;
  try {
    return sizeOf(a) === sizeOf(b);
  } catch {
    return false;
  }
}

/**
 * Prefer the current userData DB. If this launch would otherwise seed an
 * empty file, reuse a leftover database from an older Electron userData
 * folder (package name / product name changes).
 *
 * If the current file is still an untouched seed copy and a leftover live
 * DB exists, adopt that leftover instead of keeping the empty seed.
 */
export function resolvePackagedSqliteSource(
  targetFile: string,
  legacyFiles: string[],
  opts?: {
    exists?: (file: string) => boolean;
    seedFile?: string;
    sizeOf?: (file: string) => number;
  },
): { file: string; adopted: boolean } {
  const exists = opts?.exists ?? fs.existsSync;
  const sizeOf = opts?.sizeOf ?? ((file) => fs.statSync(file).size);
  const seedFile = opts?.seedFile;
  const targetLooksLikeSeed = Boolean(
    seedFile && filesLookIdentical(targetFile, seedFile, exists, sizeOf),
  );
  if (exists(targetFile) && !targetLooksLikeSeed) {
    return { file: targetFile, adopted: false };
  }
  const hit = legacyFiles.find((file) => exists(file));
  if (hit) return { file: hit, adopted: true };
  return { file: targetFile, adopted: false };
}
