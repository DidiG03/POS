/**
 * Run with: pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const setTableOpen = vi.fn();
const kdsOrderFindFirst = vi.fn();
const kdsOrderUpdate = vi.fn();
const broadcastTableStatusChanged = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    kdsOrder: {
      findFirst: (...a: any[]) => kdsOrderFindFirst(...a),
      update: (...a: any[]) => kdsOrderUpdate(...a),
    },
  },
}));

vi.mock('./core', () => ({
  coreServices: {
    setTableOpen: (...a: any[]) => setTableOpen(...a),
  },
  withTableLock: async (_a: string, _l: string, fn: () => Promise<unknown>) =>
    fn(),
}));

vi.mock('./realtime', () => ({
  broadcastTableStatusChanged: (...a: any[]) =>
    broadcastTableStatusChanged(...a),
}));

const seatCoveringReservationForOpenTable = vi.fn();
vi.mock('./reservations', () => ({
  seatCoveringReservationForOpenTable: (...a: any[]) =>
    seatCoveringReservationForOpenTable(...a),
}));

import { applyTableOpenState, setTableOpenWithSideEffects } from './tableOpen';

describe('applyTableOpenState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTableOpen.mockResolvedValue(undefined);
    kdsOrderFindFirst.mockResolvedValue(null);
    kdsOrderUpdate.mockResolvedValue({});
    seatCoveringReservationForOpenTable.mockResolvedValue(undefined);
  });

  it('opens occupancy and broadcasts', async () => {
    await applyTableOpenState('Sallon', 'T1', true);

    expect(setTableOpen).toHaveBeenCalledWith('Sallon', 'T1', true);
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Sallon',
      label: 'T1',
      open: true,
    });
    expect(kdsOrderFindFirst).not.toHaveBeenCalled();
    expect(seatCoveringReservationForOpenTable).toHaveBeenCalledWith(
      'Sallon',
      'T1',
    );
  });

  it('closes occupancy, closes KDS, and broadcasts on close', async () => {
    kdsOrderFindFirst.mockResolvedValue({ id: 42 });

    await applyTableOpenState('Sallon', 'T1', false);

    expect(setTableOpen).toHaveBeenCalledWith('Sallon', 'T1', false);
    expect(kdsOrderUpdate).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { closedAt: expect.any(Date) },
    });
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Sallon',
      label: 'T1',
      open: false,
    });
    expect(seatCoveringReservationForOpenTable).not.toHaveBeenCalled();
  });

  it('honours skipBroadcast', async () => {
    await applyTableOpenState('Bar', 'T3', true, { skipBroadcast: true });
    expect(broadcastTableStatusChanged).not.toHaveBeenCalled();
  });
});

describe('setTableOpenWithSideEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTableOpen.mockResolvedValue(undefined);
    kdsOrderFindFirst.mockResolvedValue(null);
  });

  it('returns false for empty area/label', async () => {
    expect(await setTableOpenWithSideEffects('', 'T1', true)).toBe(false);
    expect(await setTableOpenWithSideEffects('Sallon', '', true)).toBe(false);
    expect(setTableOpen).not.toHaveBeenCalled();
  });

  it('returns true after applying state', async () => {
    expect(await setTableOpenWithSideEffects('Sallon', 'T2', true)).toBe(true);
    expect(setTableOpen).toHaveBeenCalledWith('Sallon', 'T2', true);
  });
});
