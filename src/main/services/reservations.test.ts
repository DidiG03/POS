/**
 * A new booking must not land on a table the floor still shows as held.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: [] as any[] }));

vi.mock('@db/client', () => ({
  prisma: {
    reservation: { findMany: vi.fn(async () => rows) },
  },
}));
vi.mock('./realtime', () => ({ broadcastReservationsChanged: vi.fn() }));
vi.mock('./core', () => ({
  coreServices: { isTableOpen: vi.fn(async () => false) },
}));

import { assertNoTableConflict } from './reservations';

const at = (hhmm: string) => new Date(`2030-05-04T${hhmm}:00`);

function book(startsAt: Date) {
  return assertNoTableConflict({
    area: 'Salla',
    tableLabel: 'T4',
    startsAt,
    durationMin: 60,
  });
}

beforeEach(() => {
  rows.length = 0;
});

describe('assertNoTableConflict', () => {
  it('allows back-to-back bookings', async () => {
    rows.push({
      id: 1,
      status: 'BOOKED',
      startsAt: at('19:00'),
      durationMin: 90,
    });
    await expect(book(at('20:30'))).resolves.toBeUndefined();
  });

  it('holds a late-seated party from when it sat down', async () => {
    rows.push({
      id: 1,
      status: 'SEATED',
      startsAt: at('19:00'),
      seatedAt: at('19:45'),
      durationMin: 90,
    });
    await expect(book(at('20:30'))).rejects.toMatchObject({
      code: 'RESERVATION_CONFLICT',
    });
  });

  it('gives a row with no stay length the default stay', async () => {
    rows.push({
      id: 1,
      status: 'BOOKED',
      startsAt: at('19:00'),
      durationMin: 0,
    });
    await expect(book(at('19:00'))).rejects.toMatchObject({
      code: 'RESERVATION_CONFLICT',
    });
  });
});
