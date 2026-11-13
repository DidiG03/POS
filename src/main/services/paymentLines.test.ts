import { describe, expect, it, vi } from 'vitest';

const sitting = vi.hoisted(() => ({ latest: null as any }));
vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: async () => sitting.latest,
}));

import { checkPaymentLines, seatPaymentBeyondBill } from './paymentLines';

const bill = [
  { lineId: 'a', sku: 'BEER', name: 'Beer', qty: 3, unitPrice: 3 },
  { lineId: 'b', sku: 'WAT', name: 'Water', qty: 1, unitPrice: 2 },
  { lineId: 'c', sku: 'CAKE', name: 'Cake', qty: 1, unitPrice: 4, paid: true },
  { lineId: 'd', sku: 'TEA', name: 'Tea', qty: 1, unitPrice: 2, voided: true },
];

describe('seatPaymentBeyondBill', () => {
  it('accepts lines the bill has unpaid, whole or in part', () => {
    expect(
      seatPaymentBeyondBill(bill, [{ lineId: 'a', name: 'Beer', qty: 3 }]),
    ).toEqual([]);
    expect(
      seatPaymentBeyondBill(bill, [{ lineId: 'a', name: 'Beer', qty: 1 }]),
    ).toEqual([]);
    expect(
      seatPaymentBeyondBill(bill, [{ sku: 'WAT', name: 'Water', qty: 1 }]),
    ).toEqual([]);
  });

  it('refuses paid, voided, missing or extra lines', () => {
    expect(
      seatPaymentBeyondBill(bill, [{ lineId: 'c', name: 'Cake', qty: 1 }]),
    ).toEqual([{ name: 'Cake', qty: 1 }]);
    expect(
      seatPaymentBeyondBill(bill, [{ lineId: 'd', name: 'Tea', qty: 1 }]),
    ).toEqual([{ name: 'Tea', qty: 1 }]);
    expect(
      seatPaymentBeyondBill(bill, [{ lineId: 'a', name: 'Beer', qty: 5 }]),
    ).toEqual([{ name: 'Beer', qty: 2 }]);
    expect(
      seatPaymentBeyondBill(bill, [{ sku: 'WINE', name: 'Wine', qty: 1 }]),
    ).toEqual([{ name: 'Wine', qty: 1 }]);
    // Named by id and again without: together more than the bill has.
    expect(
      seatPaymentBeyondBill(bill, [
        { lineId: 'a', name: 'Beer', qty: 3 },
        { sku: 'BEER', name: 'Beer', qty: 1 },
      ]),
    ).toEqual([{ name: 'Beer', qty: 1 }]);
  });
});

describe('checkPaymentLines', () => {
  const base = {
    area: 'Main',
    tableLabel: 'T1',
    items: [{ lineId: 'a', name: 'Beer', qty: 1 }],
    closeTable: false,
    idempotencyKey: 'k1',
    refusedLines: [],
  };

  it('requires the payment key', async () => {
    const r = await checkPaymentLines({ ...base, idempotencyKey: '' });
    expect(r).toMatchObject({ code: 'APP_UPDATE_REQUIRED', permanent: true });
  });

  it('refuses lines on neither the menu nor the bill', async () => {
    const r = await checkPaymentLines({
      ...base,
      refusedLines: [
        { kind: 'refused', name: 'Lobster', sku: 'X', claimedPrice: 1 },
      ],
    });
    expect(r).toMatchObject({ code: 'NOT_ON_MENU' });
    expect(r?.error).toContain('Lobster is not on the menu');
  });

  it('checks a seat payment against the bill', async () => {
    sitting.latest = { itemsJson: bill };
    expect(await checkPaymentLines(base)).toBeNull();
    const r = await checkPaymentLines({
      ...base,
      items: [{ lineId: 'c', name: 'Cake', qty: 1 }],
    });
    expect(r).toMatchObject({ code: 'BILL_CHANGED', permanent: true });
  });

  it('leaves a payment that closes the table to the bill check it already has', async () => {
    sitting.latest = { itemsJson: bill };
    expect(
      await checkPaymentLines({
        ...base,
        closeTable: true,
        items: [{ sku: 'WINE', name: 'Wine', qty: 9 }],
      }),
    ).toBeNull();
  });
});
