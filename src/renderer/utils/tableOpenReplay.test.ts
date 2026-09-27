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
  it('opens on the live tap and sends how long ago it was tapped', async () => {
    const tappedAt = Date.now() - 1_500;
    await applyQueuedTableOpen(
      { area: 'Veranda', label: 'T29', open: true, tappedAt },
      { attempt: 0 },
    );
    expect(listOpen).not.toHaveBeenCalled();
    const age = setOpen.mock.calls[0][3] as number;
    expect(setOpen).toHaveBeenCalledWith('Veranda', 'T29', true, age);
    expect(age).toBeGreaterThanOrEqual(1_400);
    expect(age).toBeLessThan(5_000);
  });

  it('does not re-open a free table on a background replay', async () => {
    listOpen.mockResolvedValue([{ area: 'Salla', label: 'T5' }]);

    await applyQueuedTableOpen(
      { area: 'Veranda', label: 'T29', open: true, tappedAt: Date.now() },
      { attempt: 2 },
    );

    expect(setOpen).not.toHaveBeenCalled();
  });

  it('still refreshes an open that the host already has', async () => {
    listOpen.mockResolvedValue([{ area: 'Veranda', label: 'T29' }]);

    await applyQueuedTableOpen(
      { area: 'Veranda', label: 'T29', open: true, tappedAt: Date.now() },
      { attempt: 1 },
    );

    const age = setOpen.mock.calls[0][3] as number;
    expect(setOpen).toHaveBeenCalledWith('Veranda', 'T29', true, age);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(5_000);
  });

  it('still delivers a close on replay', async () => {
    await applyQueuedTableOpen(
      {
        area: 'Veranda',
        label: 'T29',
        open: false,
        tappedAt: Date.now() - 800,
      },
      { attempt: 4 },
    );
    expect(listOpen).not.toHaveBeenCalled();
    const age = setOpen.mock.calls[0][3] as number;
    expect(setOpen).toHaveBeenCalledWith('Veranda', 'T29', false, age);
    expect(age).toBeGreaterThanOrEqual(700);
    expect(age).toBeLessThan(5_000);
  });

  it('turns an older queued phone clock into an age', async () => {
    await applyQueuedTableOpen(
      {
        area: 'Veranda',
        label: 'T29',
        open: true,
        intentAt: Date.now() - 2_000,
      },
      { attempt: 0 },
    );
    const age = setOpen.mock.calls[0][3] as number;
    expect(age).toBeGreaterThanOrEqual(1_900);
    expect(age).toBeLessThan(5_000);
  });
});

describe('tryOrQueue tables.setOpen', () => {
  it('sends the age of the tap, not the phone clock', async () => {
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
    const age = setOpen.mock.calls[0][3] as number;
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(5_000);
  });
});
