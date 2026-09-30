import { beforeEach, describe, expect, it, vi } from 'vitest';

const isTableOpen = vi.fn();
const setTableOpen = vi.fn();
const broadcastTableStatusChanged = vi.fn();
const seatCoveringReservationForOpenTable = vi.fn();
const completeSeatedReservationForClosedTable = vi.fn();

vi.mock('@db/client', () => ({
  prisma: { kdsOrder: { findFirst: vi.fn(async () => null) } },
}));
vi.mock('./core', () => ({
  coreServices: {
    isTableOpen: (...a: any[]) => isTableOpen(...a),
    setTableOpen: (...a: any[]) => setTableOpen(...a),
  },
  withTableLock: async (_a: string, _l: string, fn: () => Promise<any>) => fn(),
}));
vi.mock('./realtime', () => ({
  broadcastTableStatusChanged: (...a: any[]) =>
    broadcastTableStatusChanged(...a),
}));
vi.mock('./reservations', () => ({
  seatCoveringReservationForOpenTable: (...a: any[]) =>
    seatCoveringReservationForOpenTable(...a),
  completeSeatedReservationForClosedTable: (...a: any[]) =>
    completeSeatedReservationForClosedTable(...a),
}));

import { applyTableOpenState, ensureOccupiedForTicketWrite } from './tableOpen';

describe('ensureOccupiedForTicketWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTableOpen.mockResolvedValue(true);
    seatCoveringReservationForOpenTable.mockResolvedValue(undefined);
  });

  it('is a no-op when the table is already occupied', async () => {
    isTableOpen.mockResolvedValue(true);
    await ensureOccupiedForTicketWrite('Salla', '1');
    expect(setTableOpen).not.toHaveBeenCalled();
  });

  it('opens a closed table before the ticket write', async () => {
    isTableOpen.mockResolvedValue(false);
    await ensureOccupiedForTicketWrite('Salla', '1');
    expect(setTableOpen).toHaveBeenCalledWith('Salla', '1', true, {
      intentAt: undefined,
    });
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Salla',
      label: '1',
      open: true,
    });
  });
});

describe('applyTableOpenState — close', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTableOpen.mockResolvedValue(true);
  });

  it('ends the reservation seated at a table the till closes', async () => {
    await applyTableOpenState('Salla', '5', false);
    expect(completeSeatedReservationForClosedTable).toHaveBeenCalledWith(
      'Salla',
      '5',
    );
  });

  it('leaves reservations alone when the close was stale', async () => {
    setTableOpen.mockResolvedValue(false);
    await applyTableOpenState('Salla', '5', false);
    expect(completeSeatedReservationForClosedTable).not.toHaveBeenCalled();
  });
});
