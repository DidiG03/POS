import { describe, expect, it } from 'vitest';
import { reprintAllowed } from './printJobs';

describe('reprintAllowed', () => {
  const waiter = { userId: 7, role: 'WAITER' };
  it('lets the waiter who sent it reprint a stuck or failed slip', () => {
    expect(
      reprintAllowed({ actor: waiter, jobUserId: 7, status: 'FAILED' }),
    ).toBe(true);
    expect(
      reprintAllowed({ actor: waiter, jobUserId: 7, status: 'RETRY' }),
    ).toBe(true);
  });
  it("refuses a colleague's slip", () => {
    expect(
      reprintAllowed({ actor: waiter, jobUserId: 8, status: 'FAILED' }),
    ).toBe(false);
    expect(
      reprintAllowed({ actor: waiter, jobUserId: null, status: 'FAILED' }),
    ).toBe(false);
  });
  it('refuses a slip that already printed, unless a manager asks', () => {
    expect(
      reprintAllowed({ actor: waiter, jobUserId: 7, status: 'SENT' }),
    ).toBe(false);
    expect(
      reprintAllowed({
        actor: { userId: 1, role: 'ADMIN' },
        jobUserId: 7,
        status: 'SENT',
      }),
    ).toBe(true);
  });
});
