/**
 * Integer DateTimes copied from a plain ledger must end up exactly as the
 * libSQL adapter would have written them, or date filters on the encrypted
 * ledger silently skip (`gte`) or sweep up (`lt`) every older row.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type Client, type InValue } from '@libsql/client';
import {
  DATETIME_TEXT_MARKER_KEY,
  adapterDateTimeText,
  listDatetimeColumns,
  normalizeDatetimeStorage,
  type SqlRunner,
} from './datetimeText';

const clients: Client[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function open(): { client: Client; db: SqlRunner } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-dt-'));
  dirs.push(dir);
  const client = createClient({ url: `file:${path.join(dir, 'ledger.db')}` });
  clients.push(client);
  return {
    client,
    db: {
      query: async (sql, args = []) =>
        (await client.execute({ sql, args: args as InValue[] })).rows as any,
      exec: async (sql, args = []) =>
        (await client.execute({ sql, args: args as InValue[] })).rowsAffected,
    },
  };
}

async function schema(client: Client) {
  await client.execute(
    'CREATE TABLE "SyncState" ("key" TEXT NOT NULL PRIMARY KEY, "valueJson" JSONB, "updatedAt" DATETIME NOT NULL)',
  );
  await client.execute(
    'CREATE TABLE "Order" ("id" INTEGER PRIMARY KEY, "createdAt" DATETIME NOT NULL, "closedAt" DATETIME, "note" TEXT)',
  );
  await client.execute(
    'CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY, "finished_at" DATETIME)',
  );
}

async function value(client: Client, sql: string) {
  const r = await client.execute(sql);
  return r.rows[0] as any;
}

describe('adapterDateTimeText', () => {
  it('matches what the libSQL adapter stores', () => {
    expect(adapterDateTimeText(new Date(1790722537894))).toBe(
      '2026-09-29T22:55:37.894+00:00',
    );
  });
});

describe('normalizeDatetimeStorage', () => {
  it('rewrites integer milliseconds exactly, to the millisecond', async () => {
    const { client, db } = open();
    await schema(client);
    const samples = [0, 1, 5, 999, 1000, 951782400123, 1790722537894];
    for (let i = 0; i < 2000; i++) {
      samples.push(Math.floor(Math.random() * 4_102_444_800_000));
    }
    // One transaction: a commit (and disk sync) per row took 30s+ on CI.
    await client.batch(
      samples.map((ms, i) => ({
        sql: 'INSERT INTO "Order" ("id", "createdAt") VALUES (?, ?)',
        args: [i + 1, ms],
      })),
      'write',
    );

    await normalizeDatetimeStorage(db);

    const rows = (
      await client.execute(
        'SELECT "id", typeof("createdAt") AS t, "createdAt" AS v FROM "Order" ORDER BY "id"',
      )
    ).rows as any[];
    for (const row of rows) {
      const ms = samples[Number(row.id) - 1];
      expect(row.t).toBe('text');
      expect(row.v).toBe(adapterDateTimeText(new Date(ms)));
    }
  });

  it('fixes the date filters the encrypted ledger runs', async () => {
    const { client, db } = open();
    await schema(client);
    const now = Date.parse('2026-09-30T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    // Ten days of history from the plain ledger, one row a day.
    for (let i = 0; i < 10; i++) {
      await client.execute({
        sql: 'INSERT INTO "Order" ("id", "createdAt") VALUES (?, ?)',
        args: [i + 1, now - i * day],
      });
    }
    const since = adapterDateTimeText(new Date(now - 3.5 * day));
    const count = async (op: string) =>
      Number(
        (
          await value(
            client,
            `SELECT count(*) AS n FROM "Order" WHERE "createdAt" ${op} '${since}'`,
          )
        ).n,
      );
    expect([await count('>='), await count('<')]).toEqual([0, 10]);

    await normalizeDatetimeStorage(db);

    expect([await count('>='), await count('<')]).toEqual([4, 6]);
  });

  it('rewrites SQLite CURRENT_TIMESTAMP text and leaves adapter text alone', async () => {
    const { client, db } = open();
    await schema(client);
    await client.execute(
      `INSERT INTO "Order" ("id", "createdAt", "closedAt", "note") VALUES
        (1, '2026-09-29 22:55:37', NULL, '2026-09-29 22:55:37'),
        (2, '2026-09-29T22:55:37.894+00:00', '2026-09-29T23:00:00.000+00:00', NULL)`,
    );
    await normalizeDatetimeStorage(db);
    const rows = (await client.execute('SELECT * FROM "Order" ORDER BY "id"'))
      .rows as any[];
    expect(rows[0].createdAt).toBe('2026-09-29T22:55:37.000+00:00');
    expect(rows[0].closedAt).toBeNull();
    // Not a DATETIME column: untouched even though it looks like one.
    expect(rows[0].note).toBe('2026-09-29 22:55:37');
    expect(rows[1].createdAt).toBe('2026-09-29T22:55:37.894+00:00');
    expect(rows[1].closedAt).toBe('2026-09-29T23:00:00.000+00:00');
  });

  it('leaves Prisma’s migration table alone', async () => {
    const { client, db } = open();
    await schema(client);
    const cols = await listDatetimeColumns(db);
    expect(cols.map((c) => c.table).sort()).toEqual(['Order', 'SyncState']);
  });

  it('runs once, then costs a single lookup', async () => {
    const { client, db } = open();
    await schema(client);
    await client.execute({
      sql: 'INSERT INTO "Order" ("id", "createdAt") VALUES (1, ?)',
      args: [1790722537894],
    });
    expect(await normalizeDatetimeStorage(db)).toEqual({
      skipped: false,
      updated: 1,
    });
    const marker = await value(
      client,
      `SELECT "valueJson" AS v FROM "SyncState" WHERE "key" = '${DATETIME_TEXT_MARKER_KEY}'`,
    );
    expect(JSON.parse(marker.v)).toMatchObject({ v: 1, updated: 1 });

    // Anything written afterwards is the adapter's; no rescan.
    await client.execute({
      sql: 'INSERT INTO "Order" ("id", "createdAt") VALUES (2, ?)',
      args: [1790722537894],
    });
    expect(await normalizeDatetimeStorage(db)).toEqual({
      skipped: true,
      updated: 0,
    });
  });

  it('handles a ledger that has no schema yet', async () => {
    const { db } = open();
    await expect(normalizeDatetimeStorage(db)).resolves.toEqual({
      skipped: false,
      updated: 0,
    });
  });
});
