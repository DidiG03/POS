import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: null as any,
  job: null as any,
  dispatched: [] as any[],
  notes: [] as any[],
}));

vi.mock('@db/client', () => ({
  prisma: {
    order: { findUnique: vi.fn(async () => h.order) },
    printJob: { findUnique: vi.fn(async () => h.job) },
  },
}));
vi.mock('./core', () => ({
  coreServices: { readSettings: vi.fn(async () => ({})) },
}));
vi.mock('./adminAlerts', () => ({
  notifyAdminsAndActor: vi.fn(async (n: any) => {
    h.notes.push(n);
  }),
}));
vi.mock('./printDispatcher', () => ({
  dispatchTicket: vi.fn(async (payload: any) => {
    h.dispatched.push(payload);
    return { ok: true };
  }),
}));

import {
  noticeLateFiscalReceipt,
  printFiscalReceiptForSale,
} from './fiscalReceiptReprint';

const pendingReceipt = {
  area: 'Salla',
  tableLabel: 'T4',
  items: [{ name: 'Kafe', qty: 1, unitPrice: 100 }],
  meta: {
    kind: 'PAYMENT',
    method: 'CASH',
    userId: 7,
    totalAfter: 100,
    fiscalEnabled: true,
    fiscalStatus: 'pending',
    fiscalWarning: 'Fiskalizimi is unreachable.',
  },
};

beforeEach(() => {
  h.dispatched.length = 0;
  h.notes.length = 0;
  h.job = { id: 3, idempotencyKey: 'pay-1', payloadJson: pendingReceipt };
  h.order = {
    id: 1,
    payments: [
      {
        idempotencyKey: 'pay-1',
        fiscalNivf: 'NIVF-LATE',
        fiscalNslf: 'NSLF-LATE',
        metaJson: { fiscalLink: 'https://verify.example/?iic=NSLF-LATE' },
      },
    ],
  };
});

describe('fiscal receipt of a late filing (QA F4)', () => {
  it('prints the receipt with its codes and QR link, as a reprint', async () => {
    expect(await printFiscalReceiptForSale(1)).toEqual({
      ok: true,
      printed: true,
    });
    const meta = h.dispatched[0].meta;
    expect(meta).toMatchObject({
      kind: 'PAYMENT',
      reprint: true,
      fiscalStatus: 'accepted',
      fiscalNivf: 'NIVF-LATE',
      fiscalNslf: 'NSLF-LATE',
      fiscalLink: 'https://verify.example/?iic=NSLF-LATE',
    });
    expect(meta.fiscalWarning).toBeUndefined();
  });

  it('prints nothing for a sale that is not filed yet', async () => {
    h.order.payments[0].fiscalNivf = null;
    expect(await printFiscalReceiptForSale(1)).toEqual({
      ok: false,
      error: 'not-fiscalized',
    });
    expect(h.dispatched).toHaveLength(0);
  });

  it('tells the waiter the fiscal receipt is ready', async () => {
    await noticeLateFiscalReceipt({ saleKey: 'pay-1', nivf: 'NIVF-LATE' });
    expect(h.notes[0]).toMatchObject({ actorUserId: 7 });
    expect(h.notes[0].message).toContain('NIVF-LATE');
    expect(h.notes[0].message).toContain('Salla T4');
  });
});
