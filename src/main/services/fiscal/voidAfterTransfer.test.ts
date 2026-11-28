/**
 * Busy-service run 2, #4: T4 was paid, another table was moved onto T4 41 s
 * later, and voiding a Burger on it put T4's earlier, already filed sale
 * into fiscal reviews. A moved sitting keeps its own start time, so the
 * void's window reached back over T4's last sale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claims: [] as any[],
  jobs: new Map<string, any>(),
  flagged: [] as string[],
  sessionStart: null as Date | null,
}));

vi.mock('@db/client', () => ({
  prisma: {
    printJob: {
      findUnique: async ({ where }: any) =>
        h.jobs.get(where.idempotencyKey) ?? null,
    },
    order: { findFirst: async () => null },
  },
}));
vi.mock('../tableSession', async (orig) => ({
  ...(await orig<typeof import('../tableSession')>()),
  getTableSessionStartedAt: async () => h.sessionStart,
}));
vi.mock('./claims', async (orig) => {
  const actual = await orig<typeof import('./claims')>();
  return {
    ...actual,
    findUnsentClaimForTable: async () => null,
    listFiscalClaimsForTableSince: async ({ since }: any) =>
      h.claims.filter((c) => new Date(c.record.updatedAt) >= since),
    findRegisteredClaimForTable: async ({ since }: any) =>
      h.claims.find((c) => new Date(c.record.updatedAt) >= since) ?? null,
    flagFiscalCorrectionRequired: async (input: any) => {
      h.flagged.push(input.idempotencyKey);
      return true;
    },
  };
});

import { flagVoidAfterFiscalization } from './index';

const now = Date.now();
const claim = (key: string, atMs: number) => ({
  idempotencyKey: key,
  record: {
    state: 'REGISTERED',
    updatedAt: new Date(atMs).toISOString(),
    context: { area: 'Salla', tableLabel: 'T4', saleKey: key },
  },
});

beforeEach(() => {
  h.claims = [];
  h.jobs.clear();
  h.flagged = [];
});

describe('void on a table a sitting was moved onto', () => {
  it("leaves T4's earlier paid sale alone", async () => {
    // T4 paid in full (closed the table) 41 s before the move.
    h.claims = [claim('t4-paid', now - 41_000)];
    h.jobs.set('t4-paid', { payloadJson: { meta: { kind: 'PAYMENT' } } });
    // The moved sitting started 20 minutes ago on its first table.
    h.sessionStart = new Date(now - 20 * 60_000);
    const flagged = await flagVoidAfterFiscalization({
      area: 'Salla',
      tableLabel: 'T4',
      reason: 'Burger',
    });
    expect(flagged).toBe(false);
    expect(h.flagged).toEqual([]);
  });

  it('still flags an invoice of the open bill (a seat paid part-way)', async () => {
    h.claims = [claim('t4-seat', now - 60_000)];
    h.jobs.set('t4-seat', {
      payloadJson: { meta: { kind: 'PAYMENT', closeTable: false } },
    });
    h.sessionStart = new Date(now - 20 * 60_000);
    expect(
      await flagVoidAfterFiscalization({
        area: 'Salla',
        tableLabel: 'T4',
        reason: 'x',
      }),
    ).toBe(true);
    expect(h.flagged).toEqual(['t4-seat']);
  });

  it('a void on a paid, closed table still flags its last invoice', async () => {
    h.claims = [claim('t4-paid', now - 60_000)];
    h.jobs.set('t4-paid', { payloadJson: { meta: { kind: 'PAYMENT' } } });
    h.sessionStart = null;
    expect(
      await flagVoidAfterFiscalization({
        area: 'Salla',
        tableLabel: 'T4',
        reason: 'x',
      }),
    ).toBe(true);
    expect(h.flagged).toEqual(['t4-paid']);
  });
});
