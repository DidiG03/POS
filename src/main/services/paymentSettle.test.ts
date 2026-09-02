import { beforeEach, describe, expect, it, vi } from 'vitest';

const isTableOpen = vi.fn();
const applyTableOpenState = vi.fn();
const withTableLock = vi.fn(
  async (_a: string, _l: string, fn: () => Promise<unknown>) => fn(),
);

vi.mock('./core', () => ({
  coreServices: {
    isTableOpen: (a: any, l: any) => isTableOpen(a, l),
  },
  withTableLock: (a: any, l: any, fn: any) => withTableLock(a, l, fn),
}));

vi.mock('./tableOpen', () => ({
  applyTableOpenState: (a: any, l: any, open: any) =>
    applyTableOpenState(a, l, open),
}));

import {
  TABLE_ALREADY_PAID,
  closeTableAfterAcceptedPayment,
  closeTableAfterIdempotentPayment,
  paymentPrintAccepted,
  tableAlreadyPaidResult,
  tableIsOpenForPayment,
  withPaymentLock,
} from './paymentSettle';

describe('paymentSettle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTableOpen.mockResolvedValue(true);
    applyTableOpenState.mockResolvedValue(undefined);
  });

  it('reports when the sitting is already closed', async () => {
    isTableOpen.mockResolvedValue(false);
    expect(await tableIsOpenForPayment('Sallon', 'T1')).toBe(false);
    expect(tableAlreadyPaidResult().code).toBe(TABLE_ALREADY_PAID);
  });

  it('closes the table after a fiscalized payment without taking a second lock', async () => {
    await closeTableAfterAcceptedPayment('Sallon', 'T1');
    expect(applyTableOpenState).toHaveBeenCalledWith('Sallon', 'T1', false);
    expect(withTableLock).not.toHaveBeenCalled();
  });

  it('tells the waiter the sale stuck even when the printer is down', () => {
    expect(paymentPrintAccepted(false)).toEqual({
      ok: true,
      printed: false,
      queued: true,
      tableClosed: true,
    });
    expect(paymentPrintAccepted(true).queued).toBe(false);
  });

  it('runs the payment body under the per-table lock', async () => {
    const result = await withPaymentLock('Sallon', 'T1', async () => 7);
    expect(result).toBe(7);
    expect(withTableLock).toHaveBeenCalledWith(
      'Sallon',
      'T1',
      expect.any(Function),
    );
  });

  it('closes a still-open table when a payment retry hits the PrintJob', async () => {
    isTableOpen.mockResolvedValue(true);
    const r = await closeTableAfterIdempotentPayment('Sallon', 'T1', 'PAYMENT');
    expect(r).toEqual(paymentPrintAccepted(true));
    expect(applyTableOpenState).toHaveBeenCalledWith('Sallon', 'T1', false);
  });

  it('does not re-close a table that the first payment already freed', async () => {
    isTableOpen.mockResolvedValue(false);
    await closeTableAfterIdempotentPayment('Sallon', 'T1', 'PAYMENT');
    expect(applyTableOpenState).not.toHaveBeenCalled();
  });

  it('leaves kitchen tickets alone on an idempotent print hit', async () => {
    await closeTableAfterIdempotentPayment('Sallon', 'T1', 'ORDER');
    expect(applyTableOpenState).not.toHaveBeenCalled();
    expect(withTableLock).not.toHaveBeenCalled();
  });
});
