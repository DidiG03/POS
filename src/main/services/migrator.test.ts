/**
 * Tests for the local SQLite migration runner. Prisma is mocked so the
 * suite exercises the bookkeeping and failure handling without a real
 * database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { executeRawUnsafe, queryRawUnsafe } = vi.hoisted(() => ({
  executeRawUnsafe: vi.fn(async (_sql: string, ..._args: unknown[]) => 0),
  queryRawUnsafe: vi.fn(async (_sql: string) => [] as any[]),
}));

vi.mock('@db/client', () => ({
  prisma: {
    $executeRawUnsafe: executeRawUnsafe,
    $queryRawUnsafe: queryRawUnsafe,
  },
}));

import { runPendingMigrations, splitSqlStatements } from './migrator';

describe('splitSqlStatements', () => {
  it('splits simple statements', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });

  it('keeps a trailing statement without a terminator', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('strips line and block comments', () => {
    const sql = `-- RedefineTables
PRAGMA foreign_keys=OFF;
/* a note */
SELECT 1;`;
    expect(splitSqlStatements(sql)).toEqual([
      'PRAGMA foreign_keys=OFF',
      'SELECT 1',
    ]);
  });

  it('does not split on a semicolon inside a string literal', () => {
    const sql = `INSERT INTO "t" ("v") VALUES ('a;b');`;
    expect(splitSqlStatements(sql)).toEqual([
      `INSERT INTO "t" ("v") VALUES ('a;b')`,
    ]);
  });

  it('handles escaped quotes inside string literals', () => {
    const sql = `INSERT INTO "t" VALUES ('it''s; fine'); SELECT 2;`;
    expect(splitSqlStatements(sql)).toEqual([
      `INSERT INTO "t" VALUES ('it''s; fine')`,
      'SELECT 2',
    ]);
  });

  it('does not split on a semicolon inside a quoted identifier', () => {
    const sql = `CREATE TABLE "we;ird" ("id" INTEGER); SELECT 1;`;
    expect(splitSqlStatements(sql)).toEqual([
      `CREATE TABLE "we;ird" ("id" INTEGER)`,
      'SELECT 1',
    ]);
  });

  it('parses a real Prisma RedefineTables migration', () => {
    const sql = `-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "active" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_User" ("active", "id") SELECT "active", "id" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
`;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('PRAGMA defer_foreign_keys=ON');
    expect(out[3]).toContain('INSERT INTO "new_User"');
    expect(out[4]).toBe('DROP TABLE "User"');
  });

  it('returns nothing for an empty or comment-only file', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements('-- nothing here\n')).toEqual([]);
  });

  it('parses every migration actually shipped in this repo', () => {
    const root = path.resolve(__dirname, '../../../prisma/migrations');
    const names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const file = path.join(root, name, 'migration.sql');
      if (!fs.existsSync(file)) continue;
      const statements = splitSqlStatements(fs.readFileSync(file, 'utf8'));
      expect(
        statements.length,
        `${name} produced no statements`,
      ).toBeGreaterThan(0);
      for (const s of statements) {
        // A stray terminator means the splitter mis-parsed the file.
        expect(s.endsWith(';'), `${name}: "${s.slice(0, 40)}…"`).toBe(false);
        expect(s.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('runPendingMigrations', () => {
  let dir: string;

  const writeMigration = (name: string, sql: string) => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'migration.sql'), sql);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-migrations-'));
    executeRawUnsafe.mockClear();
    queryRawUnsafe.mockClear();
    executeRawUnsafe.mockImplementation(async () => 0);
    queryRawUnsafe.mockImplementation(async () => []);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns cleanly when the directory is missing', async () => {
    const r = await runPendingMigrations(path.join(dir, 'nope'));
    expect(r.applied).toEqual([]);
    expect(r.failed).toBeNull();
  });

  it('applies pending migrations in name order', async () => {
    writeMigration('20260101000000_a', 'ALTER TABLE "A" ADD COLUMN "x" TEXT;');
    writeMigration('20260202000000_b', 'ALTER TABLE "B" ADD COLUMN "y" TEXT;');

    const r = await runPendingMigrations(dir);

    expect(r.applied).toEqual(['20260101000000_a', '20260202000000_b']);
    expect(r.failed).toBeNull();
    const statements = executeRawUnsafe.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes('"A" ADD COLUMN "x"'))).toBe(true);
    expect(
      statements.findIndex((s) => s.includes('"A"')) <
        statements.findIndex((s) => s.includes('"B"')),
    ).toBe(true);
  });

  it('skips migrations already recorded', async () => {
    writeMigration('20260101000000_a', 'ALTER TABLE "A" ADD COLUMN "x" TEXT;');
    writeMigration('20260202000000_b', 'ALTER TABLE "B" ADD COLUMN "y" TEXT;');
    queryRawUnsafe.mockImplementation(async () => [
      { migration_name: '20260101000000_a' },
    ]);

    const r = await runPendingMigrations(dir);

    expect(r.applied).toEqual(['20260202000000_b']);
    expect(r.alreadyApplied).toBe(1);
  });

  it('records a hand-patched migration as converged instead of failing', async () => {
    writeMigration('20260101000000_a', 'ALTER TABLE "A" ADD COLUMN "x" TEXT;');
    executeRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('ADD COLUMN')) {
        throw new Error('SQLITE_ERROR: duplicate column name: x');
      }
      return 0;
    });

    const r = await runPendingMigrations(dir);

    expect(r.failed).toBeNull();
    expect(r.converged).toEqual(['20260101000000_a']);
    expect(r.applied).toEqual([]);
    // It must still be written to the bookkeeping table.
    const inserts = executeRawUnsafe.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO "_prisma_migrations"'),
    );
    expect(inserts).toHaveLength(1);
  });

  it('stops on a genuine failure and leaves it unrecorded', async () => {
    writeMigration('20260101000000_a', 'ALTER TABLE "A" ADD COLUMN "x" TEXT;');
    writeMigration('20260202000000_b', 'ALTER TABLE "B" ADD COLUMN "y" TEXT;');
    executeRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('"A" ADD COLUMN')) {
        throw new Error('SQLITE_ERROR: no such table: A');
      }
      return 0;
    });

    const r = await runPendingMigrations(dir);

    expect(r.failed?.name).toBe('20260101000000_a');
    expect(r.failed?.error).toContain('no such table');
    expect(r.applied).toEqual([]);
    // The second migration must not run ahead of the failed one.
    const touchedB = executeRawUnsafe.mock.calls.some((c) =>
      String(c[0]).includes('"B" ADD COLUMN'),
    );
    expect(touchedB).toBe(false);
    const inserts = executeRawUnsafe.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO "_prisma_migrations"'),
    );
    expect(inserts).toHaveLength(0);
  });

  it('runs the pre-apply hook once, only when work is pending', async () => {
    const onBeforeApply = vi.fn(async () => {});
    writeMigration('20260101000000_a', 'ALTER TABLE "A" ADD COLUMN "x" TEXT;');
    writeMigration('20260202000000_b', 'ALTER TABLE "B" ADD COLUMN "y" TEXT;');

    await runPendingMigrations(dir, { onBeforeApply });
    expect(onBeforeApply).toHaveBeenCalledTimes(1);

    queryRawUnsafe.mockImplementation(async () => [
      { migration_name: '20260101000000_a' },
      { migration_name: '20260202000000_b' },
    ]);
    onBeforeApply.mockClear();
    await runPendingMigrations(dir, { onBeforeApply });
    expect(onBeforeApply).not.toHaveBeenCalled();
  });

  it('proceeds even if the backup hook throws', async () => {
    writeMigration('20260101000000_a', 'ALTER TABLE "A" ADD COLUMN "x" TEXT;');
    const r = await runPendingMigrations(dir, {
      onBeforeApply: async () => {
        throw new Error('disk full');
      },
    });
    expect(r.applied).toEqual(['20260101000000_a']);
  });

  it('ignores directories without a migration.sql', async () => {
    fs.mkdirSync(path.join(dir, 'not_a_migration'), { recursive: true });
    const r = await runPendingMigrations(dir);
    expect(r.applied).toEqual([]);
  });
});
