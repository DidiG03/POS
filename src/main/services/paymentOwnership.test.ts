import { describe, expect, it } from 'vitest';
import { paymentBlockedByOtherOwner } from './paymentOwnership';

describe('paymentBlockedByOtherOwner', () => {
  it('lets the owner pay their own table', () => {
    expect(
      paymentBlockedByOtherOwner({
        actorRole: 'WAITER',
        actorUserId: 7,
        ownerId: 7,
      }),
    ).toBe(false);
  });
  it("refuses a waiter paying a colleague's table", () => {
    expect(
      paymentBlockedByOtherOwner({
        actorRole: 'WAITER',
        actorUserId: 8,
        ownerId: 7,
      }),
    ).toBe(true);
  });
  it('lets a cashier or admin pay any table', () => {
    for (const role of ['CASHIER', 'ADMIN']) {
      expect(
        paymentBlockedByOtherOwner({
          actorRole: role,
          actorUserId: 8,
          ownerId: 7,
        }),
      ).toBe(false);
    }
  });
  it('a table nobody owns yet can be paid', () => {
    expect(
      paymentBlockedByOtherOwner({
        actorRole: 'WAITER',
        actorUserId: 8,
        ownerId: null,
      }),
    ).toBe(false);
  });
});
