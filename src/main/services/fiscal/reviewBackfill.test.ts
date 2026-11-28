import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, any>(),
  payments: [] as any[],
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: async ({ where }: any) =>
        h.store.has(where.key)
          ? { key: where.key, valueJson: h.store.get(where.key) }
          : null,
      create: async ({ data }: any) => {
        if (h.store.has(data.key))
          throw Object.assign(new Error('dup'), { code: 'P2002' });
        h.store.set(data.key, data.valueJson);
        return data;
      },
      upsert: async ({ where, create, update }: any) => {
        h.store.set(
          where.key,
          h.store.has(where.key) ? update.valueJson : create.valueJson,
        );
        return {};
      },
      findMany: async () =>
        [...h.store.entries()].map(([key, valueJson]) => ({
          key,
          valueJson,
          updatedAt: new Date(),
        })),
    },
    payment: { findMany: async () => h.payments },
    $queryRawUnsafe: async () => [],
  },
}));
vi.mock('./claims', async (orig) => {
  const actual = await orig<typeof import('./claims')>();
  return {
    ...actual,
    listFiscalClaimsDeferred: async () =>
      [...h.store.entries()]
        .filter(
          ([k, v]) => k.startsWith('fiscal:claim:') && v.state === 'DEFERRED',
        )
        .map(([k, record]) => ({
          idempotencyKey: k.slice('fiscal:claim:'.length),
          record,
        })),
  };
});

import {
  backfillFiscalReviews,
  paymentLacksInvoice,
  queuedButRefused,
  REVIEW_BACKFILL_KEY,
} from './reviewBackfill';

beforeEach(() => {
  h.store.clear();
  h.payments = [];
});

describe('review backfill (sales from before 0.2.114)', () => {
  it('holds a queued invoice easyPos had refused, leaves an outage queued', () => {
    expect(
      queuedButRefused({
        state: 'DEFERRED',
        lastError:
          'The tax service failed on its own side (env:SERVER): Totali nuk mund të jetë më shumë se 500000.00 ALL.',
      }),
    ).toBe(true);
    expect(
      queuedButRefused({
        state: 'DEFERRED',
        lastError: 'POST /invoice/register → HTTP 400 · bad',
      }),
    ).toBe(true);
    expect(
      queuedButRefused({
        state: 'DEFERRED',
        lastError: 'The request timed out.',
      }),
    ).toBe(false);
    expect(queuedButRefused({ state: 'DEFERRED', lastError: 'HTTP 503' })).toBe(
      false,
    );
    expect(
      queuedButRefused({
        state: 'DEFERRED',
        holdReason: 'x',
        lastError: 'HTTP 400',
      }),
    ).toBe(false);
  });

  it('knows a sale left with no invoice', () => {
    expect(
      paymentLacksInvoice({
        fiscalNivf: null,
        metaJson: { fiscalStatus: 'pending' },
      }),
    ).toBe(true);
    expect(
      paymentLacksInvoice({
        fiscalNivf: 'F1',
        metaJson: { fiscalStatus: 'pending' },
      }),
    ).toBe(false);
    expect(paymentLacksInvoice({ fiscalNivf: null, metaJson: {} })).toBe(false);
  });

  it('puts the old cash-cap sale on the review list once, and nothing else', async () => {
    h.store.set('fiscal:claim:cap-sale', {
      state: 'DEFERRED',
      attemptId: 'a',
      attempts: 9,
      createdAt: '2026-11-20T20:00:00Z',
      updatedAt: '2026-11-20T20:00:00Z',
      lastError:
        'env:SERVER: Totali nuk mund të jetë më shumë se 500000.00 ALL',
      checkStatusFirst: true,
    });
    h.store.set('fiscal:claim:outage', {
      state: 'DEFERRED',
      attemptId: 'b',
      attempts: 1,
      createdAt: 'x',
      updatedAt: 'x',
      lastError: 'ECONNREFUSED',
    });
    h.payments = [
      // Pending, with no fiskalizimi record at all.
      {
        idempotencyKey: 'lost-sale-1',
        amount: 12,
        createdAt: new Date(),
        fiscalNivf: null,
        metaJson: { fiscalStatus: 'pending' },
        order: { area: 'Salla', tableLabel: '4' },
      },
      // Pending but its claim exists: left to the queue.
      {
        idempotencyKey: 'outage',
        amount: 5,
        createdAt: new Date(),
        fiscalNivf: null,
        metaJson: { fiscalStatus: 'pending' },
      },
    ];
    const r = await backfillFiscalReviews({ now: Date.now() });
    expect(r).toEqual({ held: 1, added: 1 });
    expect(h.store.get('fiscal:claim:cap-sale').holdReason).toMatch(/refused/);
    expect(h.store.get('fiscal:claim:outage').holdReason).toBeUndefined();
    expect(h.store.get('fiscal:claim:lost-sale-1')).toMatchObject({
      state: 'UNKNOWN',
      context: { saleKey: 'lost-sale-1' },
    });
    expect(h.store.has(REVIEW_BACKFILL_KEY)).toBe(true);
    // Runs once.
    expect(await backfillFiscalReviews()).toEqual({ held: 0, added: 0 });
  });
});
