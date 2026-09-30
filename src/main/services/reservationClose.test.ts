/**
 * Closing a table on the till ends the reservation seated there, so the
 * Reservations floor does not keep a paid table busy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, updates, broadcasts } = vi.hoisted(() => ({
  rows: [] as any[],
  updates: [] as any[],
  broadcasts: [] as any[],
}));

vi.mock('@db/client', () => ({
  prisma: {
    reservation: {
      findMany: vi.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.area === where.area &&
            r.tableLabel === where.tableLabel &&
            r.status === where.status &&
            r.startsAt <= where.startsAt.lte,
        ),
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        updates.push({ id: where.id, ...data });
        return row;
      }),
    },
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('./realtime', () => ({
  broadcastReservationsChanged: (e: any) => broadcasts.push(e),
}));
vi.mock('./core', () => ({ coreServices: {} }));

import { completeSeatedReservationForClosedTable } from './reservations';

const earlier = new Date(Date.now() - 60 * 60_000);
const later = new Date(Date.now() + 60 * 60_000);

function reservation(id: number, extra: Record<string, unknown>) {
  return {
    id,
    area: 'Salla',
    tableLabel: '5',
    status: 'SEATED',
    startsAt: earlier,
    seatedAt: earlier,
    partySize: 4,
    durationMin: 120,
    name: 'Guest',
    createdById: null,
    createdAt: earlier,
    updatedAt: earlier,
    ...extra,
  };
}

beforeEach(() => {
  rows.length = 0;
  updates.length = 0;
  broadcasts.length = 0;
});

describe('completeSeatedReservationForClosedTable', () => {
  it('completes the party seated at the table and tells the floor', async () => {
    rows.push(reservation(1, {}));
    await completeSeatedReservationForClosedTable('Salla', '5');
    expect(updates).toEqual([{ id: 1, status: 'COMPLETED' }]);
    expect(broadcasts[0]).toMatchObject({ kind: 'status', id: 1 });
  });

  it('leaves later bookings and other tables alone', async () => {
    rows.push(
      reservation(2, { status: 'BOOKED', startsAt: later, seatedAt: null }),
      reservation(3, { tableLabel: '6' }),
    );
    await completeSeatedReservationForClosedTable('Salla', '5');
    expect(updates).toEqual([]);
  });

  it('never blocks closing the table', async () => {
    const { prisma } = await import('@db/client');
    vi.mocked(prisma.reservation.findMany).mockRejectedValueOnce(
      new Error('database is locked'),
    );
    await expect(
      completeSeatedReservationForClosedTable('Salla', '5'),
    ).resolves.toBeUndefined();
  });
});
