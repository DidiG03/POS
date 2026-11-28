import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({
  prisma: {
    order: {
      findMany: async ({ where }: any) => {
        const at = new Date('2026-11-20T20:00:00.500Z').getTime();
        const { gte, lte } = where.closedAt;
        return where.area === 'Main' &&
          where.tableLabel === 'T3' &&
          gte.getTime() <= at &&
          lte.getTime() >= at
          ? [{ id: 7, total: 3 }]
          : [];
      },
      findUnique: async ({ where }: any) =>
        where.id === 7
          ? {
              id: 7,
              payments: [
                {
                  idempotencyKey: 'pay-7',
                  fiscalNivf: 'NIVF-REAL',
                  fiscalNslf: 'NSLF-REAL',
                  metaJson: { fiscalQrCode: 'https://real' },
                },
              ],
            }
          : null,
    },
    // The old-shape lookups: a real payment holds NIVF-REAL; one sale was
    // closed at T3 at 20:00:00.500 for 3.00.
    payment: {
      findFirst: async ({ where }: any) =>
        where.fiscalNivf === 'NIVF-REAL' || where.fiscalNslf === 'NSLF-REAL'
          ? { orderId: 7 }
          : null,
    },
    printJob: {
      findUnique: async ({ where }: any) =>
        where.idempotencyKey === 'pay-7'
          ? {
              payloadJson: {
                area: 'Main',
                tableLabel: 'T3',
                items: [{ name: 'Espresso', qty: 2, unitPrice: 1.5 }],
                meta: { kind: 'PAYMENT', method: 'CASH', totalAfter: 3 },
              },
            }
          : null,
    },
  },
}));
vi.mock('./paymentSettle', () => ({
  isPaymentReprint: (m: any) =>
    String(m?.kind || '').toUpperCase() === 'PAYMENT' && m?.reprint === true,
}));

import {
  REPRINT_NOT_FOUND,
  REPRINT_UPDATE_APP,
  resolveDeviceReprint,
  stripClientFiscalMeta,
} from './receiptReprint';

const forged = {
  kind: 'PAYMENT',
  reprint: true,
  fiscalNivf: 'FAKE',
  fiscalQrCode: 'https://fake',
};

describe('resolveDeviceReprint', () => {
  it('refuses a reprint that names no recorded sale', async () => {
    const r = await resolveDeviceReprint({
      meta: { ...forged, reprintOf: 999 },
    });
    expect(r).toMatchObject({ kind: 'refuse', code: REPRINT_NOT_FOUND });
  });

  describe('a Waiter app older than 0.2.114 (no reprintOf)', () => {
    it('reprints by the invoice code it sends, from the stored receipt', async () => {
      const r = await resolveDeviceReprint({
        area: 'X',
        tableLabel: 'Y',
        meta: { kind: 'PAYMENT', reprint: true, fiscalNivf: 'NIVF-REAL' },
      });
      expect(r.kind).toBe('print');
      if (r.kind === 'print') {
        expect(r.payload.tableLabel).toBe('T3');
        expect(r.payload.meta.fiscalNivf).toBe('NIVF-REAL');
      }
    });

    it('reprints a sale without codes by its table, paid time and total', async () => {
      const r = await resolveDeviceReprint({
        area: 'Main',
        tableLabel: 'T3',
        meta: {
          kind: 'PAYMENT',
          reprint: true,
          paidAt: '2026-11-20T20:00:01.000Z',
          totalAfter: 3,
        },
      });
      expect(r.kind).toBe('print');
    });

    it('a forged or unknown one gets "update the Waiter app", never a silent failure', async () => {
      const r = await resolveDeviceReprint({ meta: forged });
      expect(r).toMatchObject({ kind: 'refuse', code: REPRINT_UPDATE_APP });
      if (r.kind === 'refuse') expect(r.error).toMatch(/Update the Waiter app/);
      const wrongTotal = await resolveDeviceReprint({
        area: 'Main',
        tableLabel: 'T3',
        meta: {
          kind: 'PAYMENT',
          reprint: true,
          paidAt: '2026-11-20T20:00:01.000Z',
          totalAfter: 300,
        },
      });
      expect(wrongTotal).toMatchObject({
        kind: 'refuse',
        code: REPRINT_UPDATE_APP,
      });
    });
  });

  it("prints the till's own receipt of the sale, not what was sent", async () => {
    const r = await resolveDeviceReprint({
      meta: { ...forged, reprintOf: 7 },
    });
    expect(r.kind).toBe('print');
    if (r.kind !== 'print') return;
    expect(r.payload.items).toEqual([
      { name: 'Espresso', qty: 2, unitPrice: 1.5 },
    ]);
    expect(r.payload.meta).toMatchObject({
      reprint: true,
      closeTable: false,
      fiscalNivf: 'NIVF-REAL',
      fiscalQrCode: 'https://real',
      totalAfter: 3,
    });
  });

  it('leaves other requests to the normal checks', async () => {
    expect(await resolveDeviceReprint({ meta: { kind: 'PAYMENT' } })).toEqual({
      kind: 'not-reprint',
    });
  });
});

describe('stripClientFiscalMeta', () => {
  it('removes every tax field a device sends and keeps the rest', () => {
    expect(
      stripClientFiscalMeta({
        kind: 'PAYMENT',
        method: 'CASH',
        fiscalRefusalDefer: true,
        fiscalNivf: 'FAKE',
        fiscalStatus: 'accepted',
        fiscalDoc: {},
      }),
    ).toEqual({ kind: 'PAYMENT', method: 'CASH', fiscalRefusalDefer: true });
  });
});
