/**
 * After the queue replays a table's order, the screens read that table's
 * bill at once: the table is marked open, its cached bill is dropped (so
 * the order page's next read goes to the till), and an empty read in the
 * meantime shows "Updating…" instead of a 0.00 bill (busy-service run:
 * Total 0.00 for 40-70 s after a replay although the till had the items).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { peek, writeCache } from './swrCache';
import { POS_CACHE } from './posReadCache';
import { applyPosRealtimeEvent } from './posRealtimeSync';
import { useTableStatus } from '../stores/tableStatus';
import {
  noteReplayed,
  REPLAY_SETTLE_MS,
  replayedTableEvents,
  tableRecentlyReplayed,
} from './offlineQueue';
import { decideHostBill } from './tableBill';

const order = {
  op: 'tickets.log' as const,
  args: { area: 'Salla', tableLabel: '7' },
};
const pay = {
  op: 'payments.record' as const,
  args: { area: 'Salla', tableLabel: '8' },
};

describe('replay → refetch', () => {
  beforeEach(() => useTableStatus.getState().reset());

  it('announces a replayed order as an open table with changed tickets', () => {
    expect(replayedTableEvents([order, order, pay])).toEqual([
      {
        name: 'pos:tablesChanged',
        detail: { area: 'Salla', label: '7', open: true },
      },
      {
        name: 'pos:ticketsChanged',
        detail: { area: 'Salla', tableLabel: '7' },
      },
      // A payment may or may not close its table: the till says which.
      {
        name: 'pos:ticketsChanged',
        detail: { area: 'Salla', tableLabel: '8' },
      },
    ]);
  });

  it('those events open the table and drop its cached (empty) bill', () => {
    writeCache(POS_CACHE.ticket('Salla', '7'), { items: [] });
    for (const ev of replayedTableEvents([order])) {
      applyPosRealtimeEvent(ev.name, ev.detail);
    }
    expect(useTableStatus.getState().isOpen('Salla', '7')).toBe(true);
    expect(peek(POS_CACHE.ticket('Salla', '7'))).toBeUndefined();
  });

  it('an empty read right after the replay is "updating", not an empty bill', () => {
    const now = 1_000_000;
    noteReplayed([order], now);
    expect(tableRecentlyReplayed('Salla', '7', now + 1_000)).toBe(true);
    expect(tableRecentlyReplayed('Salla', '7', now + REPLAY_SETTLE_MS)).toBe(
      false,
    );
    expect(tableRecentlyReplayed('Salla', '9', now)).toBe(false);

    const base = {
      read: { ok: true as const, items: [], note: '' },
      currentLines: [],
      hasCovers: false,
      suppressClose: false,
      withinPostSendGrace: false,
    };
    expect(decideHostBill({ ...base, pendingSend: true })).toEqual({
      kind: 'updating',
    });
    expect(decideHostBill(base).kind).toBe('empty');
    // Once the till has the items, they are shown.
    expect(
      decideHostBill({
        ...base,
        pendingSend: true,
        read: {
          ok: true,
          items: [{ name: 'Espresso', qty: 1, unitPrice: 1.5 }] as any,
          note: '',
        },
      }).kind,
    ).toBe('hydrate');
  });
});
