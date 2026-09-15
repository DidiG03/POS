import { describe, expect, it } from 'vitest';
import { resolvePackagedSqliteSource, sqliteFileGroup } from './packagedSqlite';

describe('resolvePackagedSqliteSource', () => {
  it('keeps the current userData file when it already exists', () => {
    const got = resolvePackagedSqliteSource(
      'C:/Users/sefrid/AppData/Roaming/OneTap POS/db/pos.db',
      ['C:/Users/sefrid/AppData/Roaming/code-orbit-pos/db/pos.db'],
      { exists: (file) => file.includes('OneTap POS') },
    );
    expect(got).toEqual({
      file: 'C:/Users/sefrid/AppData/Roaming/OneTap POS/db/pos.db',
      adopted: false,
    });
  });

  it('adopts a leftover code-orbit-pos database on first launch in the new folder', () => {
    const got = resolvePackagedSqliteSource(
      'C:/Users/sefrid/AppData/Roaming/OneTap POS/db/pos.db',
      ['C:/Users/sefrid/AppData/Roaming/code-orbit-pos/db/pos.db'],
      { exists: (file) => file.includes('code-orbit-pos') },
    );
    expect(got.adopted).toBe(true);
    expect(got.file).toContain('code-orbit-pos');
  });

  it('replaces an untouched seed copy when a leftover live DB exists', () => {
    const current = 'C:/Users/sefrid/AppData/Roaming/OneTap POS/db/pos.db';
    const seed = 'C:/app/resources/seed.db';
    const legacy = 'C:/Users/sefrid/AppData/Roaming/code-orbit-pos/db/pos.db';
    const got = resolvePackagedSqliteSource(current, [legacy], {
      exists: () => true,
      seedFile: seed,
      sizeOf: (file) => (file === legacy ? 9_000_000 : 1_000_000),
    });
    expect(got).toEqual({ file: legacy, adopted: true });
  });

  it('copies wal and shm beside the main file', () => {
    expect(sqliteFileGroup('/data/pos.db')).toEqual([
      '/data/pos.db',
      '/data/pos.db-wal',
      '/data/pos.db-shm',
    ]);
  });
});
