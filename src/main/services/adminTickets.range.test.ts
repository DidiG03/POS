/**
 * Staff counts pick rows by date in SQL, then filter exactly in JS. The SQL
 * must be a superset for every shape a DateTime has been stored in, or a
 * waiter's sales silently drop out of the count.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client, type InValue } from '@libsql/client';
import { ticketLogInRange } from '@shared/ticketLogItems';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./core', () => ({ coreServices: {} }));

import { dateRangeSupersetSql } from './adminTickets';

const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

const START = Date.parse('2026-10-20T00:00:00.000Z');
const END = Date.parse('2026-10-20T23:59:59.999Z');

async function idsInRange(values: InValue[], start?: number, end?: number) {
  const client = createClient({ url: ':memory:' });
  clients.push(client);
  await client.execute(
    'CREATE TABLE "T" ("id" INTEGER PRIMARY KEY, "createdAt" DATETIME)',
  );
  await client.execute('CREATE INDEX "T_createdAt" ON "T"("createdAt")');
  for (const [i, v] of values.entries()) {
    await client.execute({
      sql: 'INSERT INTO "T" VALUES (?, ?)',
      args: [i + 1, v],
    });
  }
  const q = dateRangeSupersetSql('createdAt', start, end)!;
  const rows = (
    await client.execute({
      sql: `SELECT "id", "createdAt" FROM "T" WHERE ${q.sql} ORDER BY "id"`,
      args: q.params as InValue[],
    })
  ).rows;
  return rows
    .filter((r: any) => ticketLogInRange(r.createdAt, start, end))
    .map((r: any) => Number(r.id));
}

describe('dateRangeSupersetSql', () => {
  it('finds every stored shape inside the range', async () => {
    const inside = Date.parse('2026-10-20T12:00:00.000Z');
    expect(
      await idsInRange(
        [
          inside, // INTEGER ms (plain ledger)
          Math.floor(inside / 1000), // INTEGER seconds
          '2026-10-20T12:00:00.000+00:00', // adapter TEXT (encrypted ledger)
          '2026-10-20T12:00:00.000Z',
          '2026-10-20 12:00:00', // CURRENT_TIMESTAMP style
          String(inside), // digit TEXT ms
          String(Math.floor(inside / 1000)), // digit TEXT seconds
          '2026-10-20T13:00:00.000+01:00', // zone offset
        ],
        START,
        END,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('leaves out rows just outside the range in every shape', async () => {
    const before = START - 1;
    const after = END + 1;
    expect(
      await idsInRange(
        [
          before,
          after,
          adapterText(before),
          adapterText(after),
          String(before),
          String(after),
          '2026-10-19 23:59:59',
          '2026-10-22 12:00:00',
          null,
        ],
        START,
        END,
      ),
    ).toEqual([]);
  });

  it('keeps the inclusive edges', async () => {
    expect(
      await idsInRange(
        [START, END, adapterText(START), adapterText(END)],
        START,
        END,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it('handles an open-ended range', async () => {
    expect(
      await idsInRange(
        [START - 5 * 86_400_000, END + 1, adapterText(END + 1)],
        START,
      ),
    ).toEqual([2, 3]);
    expect(dateRangeSupersetSql('createdAt')).toBeNull();
  });
});

function adapterText(ms: number): string {
  return new Date(ms).toISOString().replace(/Z$/, '+00:00');
}
