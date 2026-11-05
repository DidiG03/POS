import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sitting: { since: null as Date | null, latest: null as any },
}));
vi.mock('@db/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ id: 7, displayName: 'Ana' })),
    },
  },
}));
vi.mock('./tableSession', () => ({
  readCurrentSitting: vi.fn(async () => h.sitting),
}));

import {
  checkPaymentOwnership,
  paymentBlockedByOtherOwner,
} from './paymentOwnership';

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

describe('checkPaymentOwnership', () => {
  it('names the owner from the bill, and passes on what it read (perf)', async () => {
    const since = new Date();
    h.sitting = { since, latest: { userId: 7, itemsJson: [] } };
    const mine = await checkPaymentOwnership({
      area: 'Salla',
      tableLabel: '4',
      actorUserId: 7,
      actorRole: 'WAITER',
    });
    expect(mine).toEqual({ ok: true, ownerId: 7, sitting: h.sitting });
    expect(
      await checkPaymentOwnership({
        area: 'Salla',
        tableLabel: '4',
        actorUserId: 8,
        actorRole: 'WAITER',
      }),
    ).toMatchObject({ ok: false, code: 'TABLE_OWNED_BY_OTHER', ownerId: 7 });
  });

  it('a table with no bill yet belongs to nobody', async () => {
    h.sitting = { since: new Date(), latest: null };
    expect(
      await checkPaymentOwnership({
        area: 'Salla',
        tableLabel: '4',
        actorUserId: 8,
        actorRole: 'WAITER',
      }),
    ).toMatchObject({ ok: true, ownerId: null });
  });
});
