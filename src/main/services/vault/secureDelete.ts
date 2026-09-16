import fs from 'node:fs';
import { sqliteFileGroup } from '../packagedSqlite';

/** Overwrite then unlink so a disk image does not keep a leftover plaintext DB. */
export function secureDelete(file: string): void {
  try {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r+');
      try {
        const chunk = Buffer.alloc(64 * 1024, 0);
        let written = 0;
        while (written < size) {
          const n = Math.min(chunk.length, size - written);
          fs.writeSync(fd, chunk, 0, n, written);
          written += n;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.unlinkSync(file);
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

export function secureDeleteSqliteGroup(dbFile: string): void {
  for (const file of sqliteFileGroup(dbFile)) secureDelete(file);
}
