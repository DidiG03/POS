/**
 * Reversing a settled sale.
 *
 * What matters here is that the sale is reversed exactly once and in a way
 * reports agree with: cancelled sales leave the PAID set, corrected ones
 * carry restated totals, and either way the correction that the tax service
 * still needs is queued rather than assumed done.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, flagged, notified } = vi.hoisted(() => ({
  db: {
    orders: new Map<number, any>(),
    items: new Map<number, any>(),
    corrections: [] as any[],
    nextCorrectionId: 1,
  },
  flagged: [] as any[],
  notified: [] as any[],
}));

vi.mock('@db/client', () => ({
  prisma: {
    order: {
      findUnique: vi.fn(async ({ where }: any) => {
        const order = db.orders.get(Number(where.id));
        if (!order) return null;
        return {
          ...order,
          items: [...db.items.values()]
            .filter((it) => it.orderId === order.id)
            .sort((a, b) => a.sortOrder - b.sortOrder),
          payments: order.payment ? [order.payment] : [],
        };
      }),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ where, data }: any) => {
        const order = db.orders.get(Number(where.id));
        Object.assign(order, data);
        return order;
      }),
    },
    orderItem: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const id of where.id.in) {
          const item = db.items.get(Number(id));
          if (!item || item.orderId !== where.orderId) continue;
          Object.assign(item, data);
          count += 1;
        }
        return { count };
      }),
    },
    saleCorrection: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: db.nextCorrectionId++, ...data };
        db.corrections.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = db.corrections.find((c) => c.id === Number(where.id));
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: any) =>
      fn({
        order: {
          update: async ({ where, data }: any) => {
            Object.assign(db.orders.get(Number(where.id)), data);
          },
        },
        orderItem: {
          updateMany: async ({ where, data }: any) => {
            for (const id of where.id.in) {
              const item = db.items.get(Number(id));
              if (item && item.orderId === where.orderId) {
                Object.assign(item, data);
              }
            }
          },
        },
        saleCorrection: {
          create: async ({ data }: any) => {
            const row = { id: db.nextCorrectionId++, ...data };
            db.corrections.push(row);
            return { id: row.id };
          },
          update: async ({ where, data }: any) => {
            const row = db.corrections.find((c) => c.id === Number(where.id));
            if (row) Object.assign(row, data);
            return row;
          },
        },
      }),
    ),
    syncState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  },
}));

vi.mock('./core', () => ({
  coreServices: { readSettings: vi.fn(async () => ({ defaultVatRate: 0.2 })) },
}));

vi.mock('./adminAlerts', () => ({
  notifyAdminsAndActor: vi.fn(async (input: any) => {
    notified.push(input);
  }),
}));

vi.mock('./fiscal/claims', () => ({
  flagFiscalCorrectionRequired: vi.fn(async (input: any) => {
    flagged.push(input);
    return true;
  }),
}));

vi.mock('./fiscal/cancel', () => ({
  cancelInvoice: vi.fn(async () => ({
    kind: 'rejected',
    docId: 'cancel-test',
    message: 'not configured in test',
  })),
}));

const { registerCorrectiveInvoice } = vi.hoisted(() => ({
  registerCorrectiveInvoice: vi.fn(async () => ({
    kind: 'rejected',
    docId: 'corr-test',
    message: 'not configured in test',
  })),
}));

vi.mock('./fiscal/corrective', () => ({
  registerCorrectiveInvoice,
}));

import { applySaleCorrection, mapOrderToFiscalSaleRow } from './saleCorrection';
import { coreServices } from './core';
import { cancelInvoice } from './fiscal/cancel';

function seedSale(options?: { fiscalized?: boolean; status?: string }) {
  db.orders.set(1, {
    id: 1,
    status: options?.status || 'PAID',
    area: 'Salla',
    tableLabel: 'T7',
    total: 1500,
    subtotal: 1250,
    vatAmount: 250,
    vatEnabled: true,
    payment:
      options?.fiscalized === false
        ? { idempotencyKey: 'doc-1', fiscalNslf: null, fiscalNivf: null }
        : {
            idempotencyKey: 'doc-1',
            fiscalNslf: 'IIC-1',
            fiscalNivf: 'FIC-1',
          },
  });
  db.items.set(10, {
    id: 10,
    orderId: 1,
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
    name: 'Kafe',
    qty: 1,
    unitPrice: 500,
    vatRate: 0.2,
    sortOrder: 1,
    voidedAt: null,
  });
}

beforeEach(() => {
  db.orders.clear();
  db.items.clear();
  db.corrections.length = 0;
  db.nextCorrectionId = 1;
  flagged.length = 0;
  notified.length = 0;
  registerCorrectiveInvoice.mockClear();
});

describe('applySaleCorrection — cancellation', () => {
  it('takes the sale out of the PAID set and records why', async () => {
    seedSale();

    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Guest never served',
      actorUserId: 7,
      approvedById: 7,
    });

    expect(result).toMatchObject({ ok: true, amountDelta: -1500 });
    const order = db.orders.get(1);
    expect(order.status).toBe('VOID');
    expect(order.voidedAt).toBeInstanceOf(Date);
    // The filed figures stay put: an audit still has to show the charge.
    expect(order.total).toBe(1500);
    expect(db.corrections[0]).toMatchObject({
      kind: 'CANCEL',
      reason: 'Guest never served',
      originalNslf: 'IIC-1',
      approvedById: 7,
    });
  });

  it('queues the cancellation invoice against the original docId', async () => {
    seedSale();

    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Duplicate charge',
      actorUserId: 7,
    });

    expect(result).toMatchObject({ needsFiling: true });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      idempotencyKey: 'doc-1',
      result: { nslf: 'IIC-1', nivf: 'FIC-1' },
    });
    expect(flagged[0].reason).toContain('Cancellation invoice required');
  });

  it('marks every line struck', async () => {
    seedSale();

    await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Wrong table',
    });

    expect(db.items.get(10).voidedAt).toBeInstanceOf(Date);
    expect(db.items.get(11).voidedAt).toBeInstanceOf(Date);
  });

  it('notifies admins instead of queueing when nothing was fiscalized', async () => {
    seedSale({ fiscalized: false });

    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Test sale',
    });

    expect(result).toMatchObject({ needsFiling: false });
    expect(flagged).toHaveLength(0);
    expect(notified).toHaveLength(1);
    expect(notified[0].message).toContain('reversed');
  });

  it('stamps the cancellation IIC once CIS accepts it', async () => {
    seedSale();
    vi.mocked(coreServices.readSettings).mockResolvedValueOnce({
      defaultVatRate: 0.2,
      fiscal: { enabled: true },
    } as any);
    vi.mocked(cancelInvoice).mockResolvedValueOnce({
      kind: 'complete',
      docId: 'cancel-ok',
      identifiers: { iic: 'NSLF-CANCEL', fic: 'NIVF-CANCEL' },
    } as any);

    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CANCEL',
      reason: 'Guest never served',
    });

    expect(result).toMatchObject({
      ok: true,
      needsFiling: false,
      cancellation: { state: 'FILED', nslf: 'NSLF-CANCEL' },
    });
    expect(db.corrections[0]).toMatchObject({
      correctionNslf: 'NSLF-CANCEL',
      correctionNivf: 'NIVF-CANCEL',
    });
    expect(db.corrections[0].filedAt).toBeInstanceOf(Date);
    expect(flagged).toHaveLength(0);
  });
});

describe('applySaleCorrection — corrective', () => {
  it('restates the totals to what is left on the bill', async () => {
    seedSale();

    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CORRECTIVE',
      itemIds: [11],
      reason: 'Coffee charged twice',
    });

    expect(result).toMatchObject({ ok: true, amountDelta: -500 });
    const order = db.orders.get(1);
    expect(order.status).toBe('PAID');
    expect(order.total).toBe(1000);
    expect(order.subtotal + order.vatAmount).toBeCloseTo(1000, 2);
    expect(db.items.get(11).voidedAt).toBeInstanceOf(Date);
    expect(db.items.get(10).voidedAt).toBeNull();
  });

  it('queues a corrective invoice naming the struck lines', async () => {
    seedSale();

    await applySaleCorrection({
      orderId: 1,
      kind: 'CORRECTIVE',
      itemIds: [11],
      reason: 'Coffee charged twice',
    });

    expect(flagged[0].reason).toContain('Corrective invoice required for 1');
  });

  it('files the restated invoice when fiskalizimi is on', async () => {
    seedSale();
    vi.mocked(coreServices.readSettings).mockResolvedValueOnce({
      defaultVatRate: 0.2,
      fiscal: { enabled: true, defaultSoldIn: 'XPP' },
    } as any);
    registerCorrectiveInvoice.mockResolvedValueOnce({
      kind: 'complete',
      docId: 'corr-ok',
      identifiers: { fic: 'NIVF-CORR' },
    } as never);
    const result = await applySaleCorrection({
      orderId: 1,
      kind: 'CORRECTIVE',
      itemIds: [11],
      reason: 'Coffee charged twice',
    });

    expect(result).toMatchObject({
      ok: true,
      needsFiling: false,
      corrective: { state: 'FILED', nivf: 'NIVF-CORR' },
    });
    expect(flagged).toHaveLength(0);
    expect(registerCorrectiveInvoice).toHaveBeenCalledTimes(1);
    const calls = registerCorrectiveInvoice.mock.calls as unknown as Array<
      [
        unknown,
        {
          original: { iic: string };
          articles: Array<{ name: string }>;
          payment: Array<{ amount: number }>;
        },
      ]
    >;
    const sent = calls[0][1];
    expect(sent.original.iic).toBe('IIC-1');
    expect(sent.articles.map((a) => a.name)).toEqual(['Tavë kosi']);
    expect(sent.payment[0].amount).toBe(1000);
  });
});

describe('applySaleCorrection — guards', () => {
  it('refuses a sale already reversed', async () => {
    seedSale({ status: 'VOID' });

    expect(
      await applySaleCorrection({
        orderId: 1,
        kind: 'CANCEL',
        reason: 'Again',
      }),
    ).toEqual({ ok: false, error: 'already-void' });
    expect(db.corrections).toHaveLength(0);
  });

  it('refuses an unexplained reversal', async () => {
    seedSale();

    expect(
      await applySaleCorrection({ orderId: 1, kind: 'CANCEL', reason: '' }),
    ).toEqual({ ok: false, error: 'reason-required' });
    expect(db.orders.get(1).status).toBe('PAID');
  });

  it('refuses a sale that does not exist', async () => {
    expect(
      await applySaleCorrection({ orderId: 404, kind: 'CANCEL', reason: 'x?' }),
    ).toEqual({ ok: false, error: 'not-found' });
  });
});

describe('mapOrderToFiscalSaleRow', () => {
  it('copies fiscal identifiers off the latest payment', () => {
    const row = mapOrderToFiscalSaleRow({
      id: 7,
      closedAt: new Date('2026-09-09T12:00:00.000Z'),
      area: 'Salla',
      tableLabel: 'T7',
      userName: 'DidiG03',
      total: 1200,
      status: 'PAID',
      items: [
        {
          id: 1,
          name: 'Espresso',
          qty: 2,
          unitPrice: 150,
          voidedAt: null,
        },
      ],
      payments: [
        {
          method: 'CASH',
          fiscalNslf: 'NSLF-1',
          fiscalNivf: 'NIVF-1',
          fiscalEic: 'EIC-1',
          idempotencyKey: 'doc-1',
        },
      ],
      corrections: [],
    });
    expect(row).toMatchObject({
      orderId: 7,
      area: 'Salla',
      tableLabel: 'T7',
      userName: 'DidiG03',
      total: 1200,
      method: 'CASH',
      fiscalNslf: 'NSLF-1',
      fiscalNivf: 'NIVF-1',
      fiscalEic: 'EIC-1',
      docId: 'doc-1',
      fiscalLink: null,
      fiscalQrCode: null,
      fiscalTin: null,
    });
    expect(row.items).toEqual([
      { id: 1, name: 'Espresso', qty: 2, unitPrice: 150, voided: false },
    ]);
  });
});
