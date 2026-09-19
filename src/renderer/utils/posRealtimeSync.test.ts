import { describe, expect, it, beforeEach } from 'vitest';
import {
  invalidateCache,
  invalidateCachePrefix,
  peek,
  peekAgeMs,
  writeCache,
} from './swrCache';
import { POS_CACHE } from './posReadCache';
import { applyPosRealtimeEvent } from './posRealtimeSync';
import { useTableStatus } from '../stores/tableStatus';

function occupancyRow(
  label: string,
  userId: number,
): {
  area: string;
  label: string;
  openedAt: string;
  userId: number;
  covers: number;
  total: number;
  items: [];
  note: null;
} {
  return {
    area: 'Salla',
    label,
    openedAt: '2026-09-11T13:55:42.708Z',
    userId,
    covers: 2,
    total: 600,
    items: [],
    note: null,
  };
}

describe('applyPosRealtimeEvent', () => {
  beforeEach(() => {
    useTableStatus.getState().reset();
    invalidateCachePrefix('pos:ticket:');
    invalidateCachePrefix('pos:floor:');
    invalidateCache(POS_CACHE.openTables);
  });

  it('closes one table without wiping other waiters occupancy', () => {
    writeCache(POS_CACHE.ticket('Salla', 'T7'), { items: [{ name: 'Byrek' }] });
    writeCache(POS_CACHE.ticket('Salla', 'T8'), { items: [{ name: 'keep' }] });
    writeCache(POS_CACHE.openTables, [
      { area: 'Salla', label: 'T7' },
      { area: 'Salla', label: 'T8' },
    ]);
    writeCache(POS_CACHE.floor('Salla'), {
      tables: [occupancyRow('T7', 1), occupancyRow('T8', 2)],
    });
    useTableStatus.getState().setOpen('Salla', 'T7', true);

    applyPosRealtimeEvent('pos:tablesChanged', {
      area: 'Salla',
      label: 'T7',
      open: false,
    });

    expect(useTableStatus.getState().isOpen('Salla', 'T7')).toBe(false);
    expect(peek(POS_CACHE.ticket('Salla', 'T7'))).toBeUndefined();
    expect(
      peek<{ items?: Array<{ name?: string }> }>(
        POS_CACHE.ticket('Salla', 'T8'),
      )?.items?.[0]?.name,
    ).toBe('keep');
    expect(peek(POS_CACHE.openTables)).toEqual([
      { area: 'Salla', label: 'T8' },
    ]);
    expect(peek<{ tables: Array<{ label: string }> }>(POS_CACHE.floor('Salla'))?.tables.map((t) => t.label)).toEqual(
      ['T8'],
    );
  });

  it('opens occupancy on the host till the same way tablets do', () => {
    applyPosRealtimeEvent('pos:tablesChanged', {
      area: 'Salla',
      label: 'T8',
      open: true,
    });
    expect(useTableStatus.getState().isOpen('Salla', 'T8')).toBe(true);
  });

  it('drops the settings cache on a slim host settings event without treating it as a full document', () => {
    writeCache(POS_CACHE.settings, {
      preferences: { captureClockInOut: true, theme: 'dark' },
    });
    applyPosRealtimeEvent('pos:settingsChanged', {
      theme: 'light',
      captureClockInOut: false,
    });
    expect(peek(POS_CACHE.settings)).toBeUndefined();
  });

  it('drops the staff directory cache when Admin creates or edits a user', () => {
    writeCache(POS_CACHE.users, [{ id: 1, displayName: 'Ana' }]);
    applyPosRealtimeEvent('pos:usersChanged', { kind: 'created', id: 2 });
    expect(peek(POS_CACHE.users)).toBeUndefined();
  });

  it('patches occupancy in place so another waiter Send does not drop the floor cache', async () => {
    writeCache(POS_CACHE.ticket('Salla', 'T7'), { items: [] });
    writeCache(POS_CACHE.ticket('Salla', 'T8'), { items: [{ name: 'keep' }] });
    writeCache(POS_CACHE.openTables, [
      { area: 'Salla', label: 'T7' },
      { area: 'Salla', label: 'T8' },
    ]);
    writeCache(POS_CACHE.floor('Salla'), {
      tables: [occupancyRow('T7', 1), occupancyRow('T8', 2)],
    });
    await new Promise((r) => setTimeout(r, 15));
    const ageBefore = peekAgeMs(POS_CACHE.floor('Salla'));

    applyPosRealtimeEvent('pos:ticketsChanged', {
      area: 'Salla',
      tableLabel: 'T7',
      userId: 3,
    });

    expect(peek(POS_CACHE.ticket('Salla', 'T7'))).toBeUndefined();
    expect(
      peek<{ items?: Array<{ name?: string }> }>(
        POS_CACHE.ticket('Salla', 'T8'),
      )?.items?.[0]?.name,
    ).toBe('keep');
    expect(peek(POS_CACHE.openTables)).toEqual([
      { area: 'Salla', label: 'T7' },
      { area: 'Salla', label: 'T8' },
    ]);
    const floor = peek<{ tables: Array<{ label: string; userId: number }> }>(
      POS_CACHE.floor('Salla'),
    );
    expect(floor?.tables).toEqual([
      occupancyRow('T7', 3),
      occupancyRow('T8', 2),
    ]);
    expect(peekAgeMs(POS_CACHE.floor('Salla'))).toBeGreaterThanOrEqual(
      ageBefore ?? 0,
    );
  });
});
