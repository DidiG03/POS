import fs from 'node:fs';
import path from 'node:path';

/**
 * Replace dest with src.
 *
 * Rename first: it swaps the file in one step (POSIX, and Windows when dest
 * is not held open), so dest is never missing. Deleting dest up front left
 * a moment with neither file on disk — a power cut there lost vault.json,
 * the only copy of the ledger key. Only when the rename fails (Windows,
 * dest still open) fall back to delete-and-copy.
 */
export function replaceFile(src: string, dest: string): void {
  const from = path.resolve(src);
  const to = path.resolve(dest);
  if (from === to) return;
  try {
    fs.renameSync(from, to);
    return;
  } catch {
    // fall through
  }
  if (fs.existsSync(to)) {
    try {
      fs.unlinkSync(to);
    } catch {
      // dest may still be open; copy below overwrites it.
    }
  }
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    try {
      fs.unlinkSync(from);
    } catch {
      // ignore
    }
  }
}
