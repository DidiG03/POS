/**
 * Reversing a sale whose invoice has not reached the tax service yet.
 *
 * The sale was taken while easyPos was unreachable, so its payment row has
 * no NSLF and its invoice sits DEFERRED in the claim store. Reversing it
 * must stop that invoice going out (cancel) or replace it with one for what
 * is left (partial correction) — never let the original be filed later for
 * a sale that was cancelled. Uses the real claim store over an in-memory
 * SyncState.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, store, notified } = vi.hoisted(() => ({
  db: {
    orders: new Map<number, any>(),
    items: new Map<number, any>(),
    corrections: [] as any[],
    nextCorrectionId: 1,
  },
  store: new Map<string, { valueJson: any; updatedAt: Date }>(),
  notified: [] as any[],
}));

vi.mock('@db/client', () => {
  const tx = {
    order: {
      update: async ({ where, data }: any) => {
        Object.assign(db.orders.get(Number(where.id)), data);
      },
    },
    orderItem: {
      updateMany: async ({ where, data }: any) => {
        for (const id of where.id.in) {
          const item = db.items.get(Number(id));
          if (item && item.orderId === where.orderId) Object.assign(item, data);
        }
      },
    },
    saleCorrection: {
      create: async ({ data }: any) => {
        const row = { id: db.nextCorrectionId++, ...data };
        db.corrections.push(row);
        return { id: row.id };
      },
    },
  };
  return {
    prisma: {
      order: {
        findUnique: vi.fn(async ({ where }: any) => {
          const order = db.orders.get(Number(where.id));
          if (!order) return null;
          return {
            ...order,
            items: [...db.items.values()].filter(
              (it) => it.orderId === order.id,
            ),
            payments: order.payment ? [order.payment] : [],
          };
        }),
      },
      saleCorrection: {
        update: vi.fn(async ({ where, data }: any) => {
          const row = db.corrections.find((c) => c.id === Number(where.id));
          if (row) Object.assign(row, data);
          return row;
        }),
      },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      syncState: {
        create: vi.fn(async ({ data }: any) => {
          if (store.has(data.key)) {
            const err: any = new Error('Unique constraint failed');
            err.code = 'P2002';
            throw err;
          }
          store.set(data.key, {
            valueJson: data.valueJson,
            updatedAt: new Date(),
          });
          return { key: data.key };
        }),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const existing = store.get(where.key);
          store.set(where.key, {
            valueJson: existing ? update.valueJson : create.valueJson,
            updatedAt: new Date(),
          });
          return { key: where.key };
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          const row = store.get(where.key);
          return row ? { key: where.key, ...row } : null;
        }),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    },
  };
});

vi.mock('./core', () => ({
  coreServices: {
    readSettings: vi.fn(async () => ({
      defaultVatRate: 0.2,
      fiscal: { enabled: true },
    })),
  },
}));

vi.mock('./adminAlerts', () => ({
  notifyAdminsAndActor: vi.fn(async (input: any) => {
    notified.push(input);
  }),
}));

const { cancelInvoice, registerCorrectiveInvoice, buildDraft } = vi.hoisted(
  () => ({
    cancelInvoice: vi.fn(async () => ({
      kind: 'complete',
      docId: 'cnl-1',
      identifiers: { iic: 'IIC-CNL', fic: 'FIC-CNL' },
    })),
    registerCorrectiveInvoice: vi.fn(async () => ({
      kind: 'complete',
      docId: 'inv-corr',
      identifiers: { iic: 'IIC-C', fic: 'FIC-C' },
    })),
    buildDraft: vi.fn((payload: any, _settings: any, opts: any) => ({
      docId: opts.docId,
      articles: payload.items.map((it: any) => ({
        name: it.name,
        price: it.unitPrice,
        units: it.qty,
      })),
      payment: [{ type: 'CASH', amount: payload.meta.totalAfter }],
    })),
  }),
);
vi.mock('./fiscal/cancel', () => ({ cancelInvoice }));
vi.mock('./fiscal/corrective', () => ({ registerCorrectiveInvoice }));
vi.mock('./fiscal/mapInvoice', () => ({
  buildEasyPosInvoiceDraft: buildDraft,
}));

import { applySaleCorrection } from './saleCorrection';
import { fiscalClaimKey, readFiscalClaim } from './fiscal/claims';

const SALE_AT = '2026-09-28T10:00:00.000Z';

function seedDeferredSale(state = 'DEFERRED', extra: Record<string, any> = {}) {
  db.orders.set(1, {
    id: 1,
    status: 'PAID',
    area: 'Salla',
    tableLabel: 'T7',
    total: 1500,
    subtotal: 1250,
    vatAmount: 250,
    vatEnabled: true,
    payment: {
      idempotencyKey: 'pay-1',
      method: 'CASH',
      fiscalNslf: null,
      fiscalNivf: null,
    },
  });
  db.items.set(10, {
    id: 10,
    orderId: 1,
    sku: 'TAVE',
    name: 'Tavë kosi',
    qty: 2,
    unitPrice: 500,
    vatRate: 0.2,
    sortOrder: 0,
    voidedAt: null,
  });
  db.items.set(11, {
    id: 11,
    orderId: 1,
    sku: 'KAFE',
    name: 'Kafe',
    qty: 1,
    unitPrice: 500,
    vatRate: 0.2,
    sortOrder: 1,
    voidedAt: null,
  });
  store.set(fiscalClaimKey('pay-1'), {
    valueJson: {
      state,
      attemptId: 'att-1',
      attempts: 2,
      createdAt: SALE_AT,
      updatedAt: SALE_AT,
      context: { area: 'Salla', tableLabel: 'T7', total: 1500 },
      draft: { docId: 'pay-1', articles: [], payment: [] },
      nextAttemptAt: SALE_AT,
      ...extra,
    },
    updatedAt: new Date(),
  });
}

beforeEach(() => {
  db.orders.clear();
  db.items.clear();
  db.corrections.length = 0;
  db.nextCorrectionId = 1;
  store.clear();
  notified.length = 0;
  cancelInvoice.mockClear();
  registerCorrectiveInvoice.mockClear();
  buildDraft.mockClear();
});

describe('reversing a sale whose invoice is still waiting to be sent', () => {
  it('withdraws the invoice when the sale is cancelled', async () => {
    seedDeferredSale();
    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Guest never served',
      actorUserId: 7,
    });
    expect(result).toMatchObject({ ok: true, needsFiling: false });
    const claim = await readFiscalClaim('pay-1');
    expect(claim?.state).toBe('ABANDONED');
    expect(claim?.draft).toBeUndefined();
    // Nothing exists upstream, so there is nothing to cancel there.
    expect(cancelInvoice).not.toHaveBeenCalled();
    expect(notified.at(-1)?.message).toMatch(/withdrawn/);
  });

  it('replaces the invoice with one for the remaining lines on a partial correction', async () => {
    seedDeferredSale();
    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CORRECTIVE',
      itemIds: [11],
      reason: 'Coffee returned',
      actorUserId: 7,
    });
    expect(result).toMatchObject({ ok: true, needsFiling: false });
    expect(registerCorrectiveInvoice).not.toHaveBeenCalled();

    const original = await readFiscalClaim('pay-1');
    expect(original?.state).toBe('ABANDONED');
    const replacement = String(original?.replacedBy || '');
    expect(replacement).toMatch(/^inv-/);

    const restated = await readFiscalClaim(replacement);
    expect(restated?.state).toBe('DEFERRED');
    expect(restated?.context).toMatchObject({
      area: 'Salla',
      tableLabel: 'T7',
      saleKey: 'pay-1',
      total: 1000,
    });
    // The 48-hour window still runs from the sale.
    expect(restated?.createdAt).toBe(SALE_AT);
    expect((restated?.draft as any)?.articles).toEqual([
      { name: 'Tavë kosi', price: 500, units: 2 },
    ]);
  });

  it('names the service charge on the replacement invoice', async () => {
    seedDeferredSale();
    Object.assign(db.orders.get(1), { total: 1650, serviceChargeAmount: 150 });
    await applySaleCorrection({
      orderId: 1,
      kind: 'CORRECTIVE',
      itemIds: [11],
      reason: 'Coffee returned',
    });
    const meta = (buildDraft.mock.calls as any).at(-1)[0].meta;
    expect(meta).toMatchObject({ totalAfter: 1150, serviceChargeAmount: 150 });
  });

  it('follows the replacement on a second correction', async () => {
    seedDeferredSale();
    await applySaleCorrection({
      orderId: 1,
      kind: 'CORRECTIVE',
      itemIds: [11],
      reason: 'Coffee returned',
    });
    const first = String((await readFiscalClaim('pay-1'))?.replacedBy);
    await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Whole table walked out',
    });
    expect((await readFiscalClaim(first))?.state).toBe('ABANDONED');
    expect(cancelInvoice).not.toHaveBeenCalled();
  });

  it('cancels upstream when the invoice was filed but never stamped on the sale', async () => {
    seedDeferredSale('REGISTERED', {
      result: { nslf: 'IIC-9', nivf: 'FIC-9' },
      draft: undefined,
    });
    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Guest never served',
    });
    expect(cancelInvoice).toHaveBeenCalledTimes(1);
    expect((cancelInvoice.mock.calls[0] as any)[1]).toMatchObject({
      target: { iic: 'IIC-9' },
    });
    expect(result).toMatchObject({ ok: true, needsFiling: false });
  });

  it('leaves an unconfirmed invoice for review and says so', async () => {
    seedDeferredSale('UNKNOWN', { lastError: 'timeout', draft: undefined });
    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Guest never served',
    });
    expect(result).toMatchObject({ ok: true, needsFiling: true });
    const claim = await readFiscalClaim('pay-1');
    expect(claim?.state).toBe('UNKNOWN');
    expect(claim?.lastError).toMatch(/cancel it there/);
    expect(cancelInvoice).not.toHaveBeenCalled();
  });
});
