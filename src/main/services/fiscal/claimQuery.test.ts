/**
 * The claim listings filter inside SQLite. Run the real SQL against a real
 * SQLite so a wrong range or JSON path cannot hide a deferred invoice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client, type InValue } from '@libsql/client';

vi.mock('@db/client', () => ({ prisma: {} }));

import { claimStateQuery } from './claims';

const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

async function ledger(rows: Array<[string, string]>) {
  const client = createClient({ url: ':memory:' });
  clients.push(client);
  await client.execute(
    'CREATE TABLE "SyncState" ("key" TEXT NOT NULL PRIMARY KEY, "valueJson" JSONB, "updatedAt" DATETIME NOT NULL)',
  );
  for (const [key, valueJson] of rows) {
    await client.execute({
      sql: `INSERT INTO "SyncState" ("key", "valueJson", "updatedAt") VALUES (?, ?, '2026-09-30T00:00:00.000+00:00')`,
      args: [key, valueJson],
    });
  }
  return async (q: { sql: string; args: string[] }) =>
    (await client.execute({ sql: q.sql, args: q.args as InValue[] })).rows
      .map((r: any) => String(r.key))
      .sort();
}

const claim = (state: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ state, attemptId: 'a', ...extra });

describe('claimStateQuery', () => {
  it('returns exactly the claims in the asked states', async () => {
    const run = await ledger([
      ['fiscal:claim:pay-1', claim('DEFERRED')],
      ['fiscal:claim:pay-2', claim('REGISTERED')],
      ['fiscal:claim:pay-3', claim('DEFERRED', { draft: { docId: 'x' } })],
      ['fiscal:claim:pay-4', claim('UNKNOWN')],
    ]);
    expect(await run(claimStateQuery(['DEFERRED']))).toEqual([
      'fiscal:claim:pay-1',
      'fiscal:claim:pay-3',
    ]);
  });

  it('stays inside the claim keys', async () => {
    const run = await ledger([
      ['fiscal:claim:pay-1', claim('DEFERRED')],
      ['fiscal:claim;odd', claim('DEFERRED')],
      ['fiscal:claimz', claim('DEFERRED')],
      ['fiscal:balance:movement:1', claim('DEFERRED')],
      ['fiscal:clai', claim('DEFERRED')],
    ]);
    expect(await run(claimStateQuery(['DEFERRED']))).toEqual([
      'fiscal:claim:pay-1',
    ]);
  });

  it('is not derailed by a row that is not valid JSON', async () => {
    const run = await ledger([
      ['fiscal:claim:broken', '{not json'],
      ['fiscal:claim:pay-1', claim('DEFERRED')],
    ]);
    expect(await run(claimStateQuery(['DEFERRED']))).toEqual([
      'fiscal:claim:pay-1',
    ]);
  });

  it('adds filed invoices nobody matched to a sale when asked', async () => {
    const run = await ledger([
      ['fiscal:claim:pay-1', claim('UNKNOWN')],
      ['fiscal:claim:pay-2', claim('CORRECTION_REQUIRED')],
      [
        'fiscal:claim:pay-3',
        claim('REGISTERED', { orphanDetectedAt: '2026-09-30' }),
      ],
      ['fiscal:claim:pay-4', claim('REGISTERED')],
    ]);
    expect(
      await run(
        claimStateQuery(['UNKNOWN', 'CORRECTION_REQUIRED'], {
          orphanedRegistered: true,
        }),
      ),
    ).toEqual([
      'fiscal:claim:pay-1',
      'fiscal:claim:pay-2',
      'fiscal:claim:pay-3',
    ]);
  });
});
