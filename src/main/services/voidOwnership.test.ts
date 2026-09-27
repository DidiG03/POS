import { describe, expect, it } from 'vitest';
import { voidBlockedByOtherOwner } from './voidOwnership';

describe('voidBlockedByOtherOwner', () => {
  it('stops a waiter from voiding another waiter’s table', () => {
    expect(
      voidBlockedByOtherOwner({
        actorIsAdmin: false,
        actorUserId: 4,
        ownerId: 9,
        approvalLifts: false,
      }),
    ).toBe(true);
  });

  it('allows the waiter who opened the table', () => {
    expect(
      voidBlockedByOtherOwner({
        actorIsAdmin: false,
        actorUserId: 9,
        ownerId: 9,
        approvalLifts: false,
      }),
    ).toBe(false);
  });

  it('allows a table with no owner on this sitting', () => {
    expect(
      voidBlockedByOtherOwner({
        actorIsAdmin: false,
        actorUserId: 4,
        ownerId: null,
        approvalLifts: false,
      }),
    ).toBe(false);
  });

  it('lets an admin void any table', () => {
    expect(
      voidBlockedByOtherOwner({
        actorIsAdmin: true,
        actorUserId: 1,
        ownerId: 9,
        approvalLifts: false,
      }),
    ).toBe(false);
  });

  it('lets a verified manager approval void any table', () => {
    expect(
      voidBlockedByOtherOwner({
        actorIsAdmin: false,
        actorUserId: 4,
        ownerId: 9,
        approvalLifts: true,
      }),
    ).toBe(false);
  });
});
