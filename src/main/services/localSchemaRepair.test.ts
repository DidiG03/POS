import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'schema-repair-'),
  );
  process.env.DATABASE_URL = `file:${dir}/pos.db?connection_limit=1`;
  (globalThis as any).__schemaRepairDir = dir;
});

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0' },
  BrowserWindow: { getAllWindows: () => [] },
  default: {},
}));

import { prisma } from '@db/client';
import { runPendingMigrations } from './migrator';
import {
  isAlreadyAppliedError,
  LOCAL_SCHEMA_REPAIR_STATEMENTS,
  repairLocalSchema,
} from './localSchemaRepair';

const MIGRATIONS = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
);

function allMigrationSql(): string {
  return fs
    .readdirSync(MIGRATIONS)
    .map((d) => path.join(MIGRATIONS, d, 'migration.sql'))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

/** The column, index or table a repair statement creates. */
function objectOf(sql: string): string {
  const col = /ADD COLUMN "([^"]+)"/.exec(sql);
  if (col) return `"${col[1]}"`;
  const named = /(?:INDEX|TABLE) IF NOT EXISTS "([^"]+)"/.exec(sql);
  if (named) return `"${named[1]}"`;
  throw new Error(`unrecognised repair statement: ${sql}`);
}

beforeAll(async () => {
  const res = await runPendingMigrations(MIGRATIONS);
  expect(res.failed, JSON.stringify(res.failed)).toBeNull();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
  fs.rmSync((globalThis as any).__schemaRepairDir, {
    recursive: true,
    force: true,
  });
});

describe('local schema repair', () => {
  it('only repeats what a real migration creates', () => {
    const sql = allMigrationSql();
    for (const stmt of LOCAL_SCHEMA_REPAIR_STATEMENTS) {
      expect(sql, stmt).toContain(objectOf(stmt));
    }
  });

  it('finds nothing to fix on a fully migrated database', async () => {
    const failures: string[] = [];
    await repairLocalSchema(
      (s) => (prisma as any).$executeRawUnsafe(s),
      (s, e) => failures.push(`${s}: ${String((e as any)?.message || e)}`),
    );
    expect(failures).toEqual([]);
  });

  it('keeps going after a failure and reports it', async () => {
    const reported: string[] = [];
    const ran: string[] = [];
    const first = LOCAL_SCHEMA_REPAIR_STATEMENTS[0];
    const result = await repairLocalSchema(
      async (s) => {
        ran.push(s);
        if (s === first) throw new Error('disk I/O error');
        throw new Error('duplicate column name: x');
      },
      (s) => reported.push(s),
    );
    expect(ran).toHaveLength(LOCAL_SCHEMA_REPAIR_STATEMENTS.length);
    expect(reported).toEqual([first]);
    expect(result).toEqual({ applied: 0, failed: 1 });
  });

  it('treats "already there" answers as expected', () => {
    expect(
      isAlreadyAppliedError(new Error('duplicate column name: color')),
    ).toBe(true);
    expect(isAlreadyAppliedError(new Error('index X already exists'))).toBe(
      true,
    );
    expect(isAlreadyAppliedError(new Error('no such table: Covers'))).toBe(
      false,
    );
  });
});
