/**
 * Run with: pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncStateFindUnique = vi.fn();
const syncStateUpsert = vi.fn();
const setTableOpen = vi.fn();
const kdsOrderFindFirst = vi.fn();
const kdsOrderUpdate = vi.fn();
const broadcastTableStatusChanged = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: (...a: any[]) => syncStateFindUnique(...a),
      upsert: (...a: any[]) => syncStateUpsert(...a),
    },
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

import { applyTableOpenState, setTableOpenWithSideEffects } from './tableOpen';

describe('applyTableOpenState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncStateFindUnique.mockResolvedValue({ valueJson: {} });
    syncStateUpsert.mockResolvedValue({});
    setTableOpen.mockResolvedValue(undefined);
    kdsOrderFindFirst.mockResolvedValue(null);
    kdsOrderUpdate.mockResolvedValue({});
  });

  it('sets openAt on first open and broadcasts', async () => {
    await applyTableOpenState('Sallon', 'T1', true);

    expect(setTableOpen).toHaveBeenCalledWith('Sallon', 'T1', true);
    expect(syncStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'tables:openAt' },
        create: expect.objectContaining({
          valueJson: expect.objectContaining({
            'Sallon:T1': expect.any(String),
          }),
        }),
      }),
    );
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Sallon',
      label: 'T1',
      open: true,
    });
    expect(kdsOrderFindFirst).not.toHaveBeenCalled();
  });

  it('does not reset openAt when re-opening an already-open table', async () => {
    syncStateFindUnique.mockResolvedValue({
      valueJson: { 'Sallon:T1': '2026-01-01T10:00:00.000Z' },
    });

    await applyTableOpenState('Sallon', 'T1', true);

    expect(syncStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          valueJson: { 'Sallon:T1': '2026-01-01T10:00:00.000Z' },
        },
      }),
    );
  });

  it('clears openAt, closes KDS, and broadcasts on close', async () => {
    syncStateFindUnique.mockResolvedValue({
      valueJson: { 'Sallon:T1': '2026-01-01T10:00:00.000Z' },
    });
    kdsOrderFindFirst.mockResolvedValue({ id: 42 });

    await applyTableOpenState('Sallon', 'T1', false);

    expect(setTableOpen).toHaveBeenCalledWith('Sallon', 'T1', false);
    expect(syncStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { valueJson: {} },
      }),
    );
    expect(kdsOrderUpdate).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { closedAt: expect.any(Date) },
    });
    expect(broadcastTableStatusChanged).toHaveBeenCalledWith({
      area: 'Sallon',
      label: 'T1',
      open: false,
    });
  });

  it('honours skipBroadcast', async () => {
    await applyTableOpenState('Bar', 'T3', true, { skipBroadcast: true });
    expect(broadcastTableStatusChanged).not.toHaveBeenCalled();
  });
});

describe('setTableOpenWithSideEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncStateFindUnique.mockResolvedValue({ valueJson: {} });
    syncStateUpsert.mockResolvedValue({});
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
