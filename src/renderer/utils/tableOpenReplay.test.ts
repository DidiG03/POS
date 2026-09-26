/**
 * Replaying a queued "open table" after the sitting was paid is how a
 * waiter logs in, starts an order, and watches other tables turn red
 * with nothing on them but the timer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyQueuedTableOpen, tryOrQueue } from './offlineQueue';

const setOpen = vi.fn();
const listOpen = vi.fn();

beforeEach(() => {
  setOpen.mockReset();
  listOpen.mockReset();
  setOpen.mockResolvedValue(true);
  listOpen.mockResolvedValue([]);
  (globalThis as any).window = {
    api: { tables: { setOpen, listOpen } },
  };
});

describe('applyQueuedTableOpen', () => {
  it('opens on the live tap and stamps the tap time', async () => {
    await applyQueuedTableOpen(
      { area: 'Veranda', label: 'T29', open: true, intentAt: 1_700 },
      { attempt: 0 },
    );
    expect(listOpen).not.toHaveBeenCalled();
    expect(setOpen).toHaveBeenCalledWith('Veranda', 'T29', true, 1_700);
  });

  it('does not re-open a free table on a background replay', async () => {
    listOpen.mockResolvedValue([{ area: 'Salla', label: 'T5' }]);

    await applyQueuedTableOpen(
      { area: 'Veranda', label: 'T29', open: true, intentAt: 1_700 },
      { attempt: 2 },
    );

    expect(setOpen).not.toHaveBeenCalled();
  });

  it('still refreshes an open that the host already has', async () => {
    listOpen.mockResolvedValue([{ area: 'Veranda', label: 'T29' }]);

    await applyQueuedTableOpen(
      { area: 'Veranda', label: 'T29', open: true, intentAt: 1_700 },
      { attempt: 1 },
    );

    expect(setOpen).toHaveBeenCalledWith('Veranda', 'T29', true, 1_700);
  });

  it('still delivers a close on replay', async () => {
    await applyQueuedTableOpen(
      { area: 'Veranda', label: 'T29', open: false, intentAt: 1_800 },
      { attempt: 4 },
    );
    expect(listOpen).not.toHaveBeenCalled();
    expect(setOpen).toHaveBeenCalledWith('Veranda', 'T29', false, 1_800);
  });
});

describe('tryOrQueue tables.setOpen', () => {
  it('stamps a tap time so a late delivery can lose to a newer close', async () => {
    await tryOrQueue('tables.setOpen', {
      area: 'Salla',
      label: '1',
      open: true,
    });
    expect(setOpen).toHaveBeenCalledWith(
      'Salla',
      '1',
      true,
      expect.any(Number),
    );
    const stamped = setOpen.mock.calls[0][3] as number;
    expect(stamped).toBeGreaterThan(1_000_000_000_000);
  });
});
