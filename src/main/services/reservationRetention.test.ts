import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./core', () => ({ coreServices: { readSettings: vi.fn() } }));

import { anonymiseOldReservations } from './reservationRetention';
import {
  guestRetentionCutoff,
  guestRetentionMonths,
  guestRetentionProblem,
} from '@shared/guestDataRetention';

describe('guest data retention', () => {
  it('keeps guests 12 months unless the venue chose otherwise', () => {
    expect(guestRetentionMonths({})).toBe(12);
    expect(
      guestRetentionMonths({ privacy: { reservationGuestMonths: 3 } }),
    ).toBe(3);
    expect(
      guestRetentionMonths({ privacy: { reservationGuestMonths: 7 } }),
    ).toBe(12);
  });

  it('refuses a period that is not offered', () => {
    expect(guestRetentionProblem(12)).toBeNull();
    expect(guestRetentionProblem(0)).toMatch(/months/);
  });

  it('anonymises reservations dated before the cutoff, and only those', async () => {
    const updateMany = vi.fn(async (_args: any) => ({ count: 4 }));
    const now = new Date('2026-11-16T12:00:00Z');
    const n = await anonymiseOldReservations({
      months: 12,
      now,
      db: { reservation: { updateMany } },
    });
    expect(n).toBe(4);
    const args = updateMany.mock.calls[0][0];
    expect(args.where.startsAt.lt).toEqual(guestRetentionCutoff(12, now));
    expect(args.where.startsAt.lt.getFullYear()).toBe(2025);
    expect(args.data).toEqual({
      customerName: 'Guest',
      customerPhone: null,
      note: null,
    });
  });
});
