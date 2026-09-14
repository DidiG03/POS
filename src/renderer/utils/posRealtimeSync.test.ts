import { describe, expect, it, beforeEach } from 'vitest';
import {
  invalidateCache,
  invalidateCachePrefix,
  peek,
  writeCache,
} from './swrCache';
import { POS_CACHE } from './posReadCache';
import { applyPosRealtimeEvent } from './posRealtimeSync';
import { useTableStatus } from '../stores/tableStatus';

describe('applyPosRealtimeEvent', () => {
  beforeEach(() => {
    useTableStatus.getState().reset();
    invalidateCachePrefix('pos:ticket:');
    invalidateCachePrefix('pos:floor:');
    invalidateCache(POS_CACHE.openTables);
  });

  it('drops ticket and floor caches when another till closes a table', () => {
    writeCache(POS_CACHE.ticket('Salla', 'T7'), { items: [{ name: 'Byrek' }] });
    writeCache(POS_CACHE.ticket('Salla', 'T8'), { items: [{ name: 'keep' }] });
    writeCache(POS_CACHE.openTables, [{ area: 'Salla', label: 'T7' }]);
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
    expect(peek(POS_CACHE.openTables)).toBeUndefined();
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

  it('invalidates one ticket when another waiter sends to it', () => {
    writeCache(POS_CACHE.ticket('Salla', 'T7'), { items: [] });
    writeCache(POS_CACHE.ticket('Salla', 'T8'), { items: [{ name: 'keep' }] });
    applyPosRealtimeEvent('pos:ticketsChanged', {
      area: 'Salla',
      tableLabel: 'T7',
    });
    expect(peek(POS_CACHE.ticket('Salla', 'T7'))).toBeUndefined();
    expect(
      peek<{ items?: Array<{ name?: string }> }>(
        POS_CACHE.ticket('Salla', 'T8'),
      )?.items?.[0]?.name,
    ).toBe('keep');
  });
});
