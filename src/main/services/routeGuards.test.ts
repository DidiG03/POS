import { describe, expect, it } from 'vitest';
import {
  NO_OPEN_BILL,
  paymentReceiptPrints,
  voidTicketWithoutBill,
} from './routeGuards';

describe('void-ticket on a table with no bill', () => {
  it('is refused with NO_OPEN_BILL, not "ok"', () => {
    const r = voidTicketWithoutBill({ hasSitting: false, tableOpen: false });
    expect(r?.status).toBe(404);
    expect(r?.body).toMatchObject({ code: NO_OPEN_BILL, permanent: true });
  });

  it('goes ahead for a bill, or an open table to clear', () => {
    expect(
      voidTicketWithoutBill({ hasSitting: true, tableOpen: true }),
    ).toBeNull();
    expect(
      voidTicketWithoutBill({ hasSitting: false, tableOpen: true }),
    ).toBeNull();
  });
});

describe('record-only payments', () => {
  it('do not print', () => {
    expect(paymentReceiptPrints({ recordOnly: true, kind: 'PAYMENT' })).toBe(
      false,
    );
  });
  it('everything else still prints', () => {
    expect(paymentReceiptPrints({ kind: 'PAYMENT' })).toBe(true);
    expect(paymentReceiptPrints({ recordOnly: false, kind: 'PAYMENT' })).toBe(
      true,
    );
    expect(paymentReceiptPrints({ recordOnly: 'true', kind: 'PAYMENT' })).toBe(
      true,
    );
  });
});
