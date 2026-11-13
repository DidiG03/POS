import { describe, expect, it, vi } from 'vitest';

const sitting = vi.hoisted(() => ({ current: null as any }));
vi.mock('./tableSession', () => ({
  findLatestTicketLogForCurrentSession: async () => sitting.current,
}));
vi.mock('@db/client', () => ({ prisma: {} }));

import {
  billSlipAmount,
  billSlipLines,
  checkBillSlip,
  slipKindOf,
} from './billSlip';

const bill = [
  { lineId: 'a', name: 'Espresso', qty: 2, unitPrice: 1.5, seatId: 's1' },
  { lineId: 'b', name: 'Water', qty: 1, unitPrice: 2, seatId: 's2' },
  { lineId: 'c', name: 'Cake', qty: 1, unitPrice: 4, voided: true },
  { lineId: 'd', name: 'Tea', qty: 1, unitPrice: 3, paid: true },
];

describe('slipKindOf', () => {
  it('treats no kind as a bill', () => {
    expect(slipKindOf(undefined)).toBe('TICKET');
    expect(slipKindOf({ kind: 'order' })).toBe('ORDER');
  });
});

describe('billSlipLines', () => {
  it('prints the unpaid bill, never what the device sent', () => {
    const out = billSlipLines(
      bill as any,
      [{ name: 'Lobster', qty: 1, unitPrice: 0.01 }],
      null,
    );
    expect(out.map((l) => l.name)).toEqual(['Espresso', 'Water']);
    expect(billSlipAmount(out)).toBe(5);
  });

  it('prints one seat when asked', () => {
    expect(billSlipLines(bill as any, [], 's2').map((l) => l.name)).toEqual([
      'Water',
    ]);
  });

  it('prints the lines the device named, as the till has them', () => {
    const out = billSlipLines(
      bill as any,
      [{ lineId: 'a', name: 'Espresso', qty: 9, unitPrice: 0.1 }],
      null,
    );
    expect(out).toEqual([bill[0]]);
    // Naming a line the bill does not have falls back to the whole bill.
    expect(
      billSlipLines(bill as any, [{ lineId: 'zz', name: 'X' }], null),
    ).toHaveLength(2);
  });
});

describe('checkBillSlip', () => {
  it('refuses a kind the till does not know', async () => {
    const r = await checkBillSlip({
      area: 'A',
      tableLabel: '1',
      meta: { kind: 'INVOICE' },
      items: [],
    });
    expect(r).toMatchObject({ kind: 'refuse', code: 'UNKNOWN_SLIP_KIND' });
  });

  it('leaves kitchen slips and payments to their own checks', async () => {
    for (const kind of ['ORDER', 'PAYMENT', 'RECEIPT']) {
      expect(
        await checkBillSlip({
          area: 'A',
          tableLabel: '1',
          meta: { kind },
          items: [],
        }),
      ).toEqual({ kind: 'not-bill' });
    }
  });

  it('refuses a bill for a table with nothing on it', async () => {
    sitting.current = null;
    const r = await checkBillSlip({
      area: 'A',
      tableLabel: '1',
      meta: {},
      items: [{ name: 'Lobster', qty: 1, unitPrice: 100 }],
    });
    expect(r).toMatchObject({ kind: 'refuse', code: 'NOTHING_TO_BILL' });
  });

  it('builds the bill from the till', async () => {
    sitting.current = { id: 5, itemsJson: bill };
    const r = await checkBillSlip({
      area: 'A',
      tableLabel: '1',
      meta: {},
      items: [{ name: 'Lobster', qty: 1, unitPrice: 100 }],
    });
    expect(r.kind).toBe('print');
    if (r.kind === 'print') {
      expect(r.items.map((l) => l.name)).toEqual(['Espresso', 'Water']);
      expect(r.amount).toBe(5);
    }
  });
});
