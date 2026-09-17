import fs from 'node:fs';
import path from 'node:path';

/** Replace dest with src. Windows cannot always rename over an open file. */
export function replaceFile(src: string, dest: string): void {
  const from = path.resolve(src);
  const to = path.resolve(dest);
  if (from === to) return;
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
