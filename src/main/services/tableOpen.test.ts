import { beforeEach, describe, expect, it, vi } from 'vitest';

const isTableOpen = vi.fn();
const setTableOpen = vi.fn();
const broadcastTableStatusChanged = vi.fn();
const seatCoveringReservationForOpenTable = vi.fn();

vi.mock('@db/client', () => ({ prisma: {} }));
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
}));

import { ensureOccupiedForTicketWrite } from './tableOpen';

describe('ensureOccupiedForTicketWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTableOpen.mockResolvedValue(undefined);
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
    expect(setTableOpen).toHaveBeenCalledWith('Salla', '1', true);
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Salla',
      label: '1',
      open: true,
    });
  });
});
