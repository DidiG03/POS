import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({
  prisma: {
    order: {
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
    const r = await resolveDeviceReprint({ meta: forged });
    expect(r).toMatchObject({ kind: 'refuse', code: REPRINT_NOT_FOUND });
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
