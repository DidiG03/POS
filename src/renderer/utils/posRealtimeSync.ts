/**
 * One cache + occupancy path for every live event, whether it arrived
 * over tablet SSE or Electron IPC. Without this, the host till kept
 * stale `listOpen` / floor SWR while tablets dropped those caches.
 */
import { useTableStatus } from '../stores/tableStatus';
import { useTicketStore } from '../stores/ticket';
import { applyHostPosUiTheme } from '../theme';
import { themeFromChange } from '@shared/settingsChange';
import {
  emitPosSyncCatchupSoon,
  invalidateFloorSnapshots,
  invalidateTicketCache,
  POS_CACHE,
} from './posReadCache';
import { invalidateCache } from './swrCache';

export type PosRealtimeEventName =
  | 'pos:tablesChanged'
  | 'pos:ticketsChanged'
  | 'pos:layoutChanged'
  | 'pos:tableMergesChanged'
  | 'pos:settingsChanged';

type RealtimePayload = {
  area?: string;
  label?: string;
  tableLabel?: string;
  open?: boolean;
};

export function applyPosRealtimeEvent(
  eventName: string,
  payload: unknown,
): void {
  const p = (payload || {}) as RealtimePayload;
  const area = String(p.area || '');
  const label = String(p.tableLabel || p.label || '');

  if (eventName === 'pos:ticketsChanged') {
    if (area && label) invalidateTicketCache(area, label);
    invalidateFloorSnapshots();
    return;
  }

  if (eventName === 'pos:tablesChanged') {
    if (area && label && typeof p.open === 'boolean') {
      useTableStatus.getState().setOpen(area, label, p.open);
      if (!p.open) {
        invalidateTicketCache(area, label);
        const openKeys = Object.entries(useTableStatus.getState().openMap)
          .filter(([, open]) => open)
          .map(([k]) => k);
        useTicketStore.getState().dropOrphanLiveBills(openKeys);
      }
    }
    invalidateFloorSnapshots();
    return;
  }

  if (
    eventName === 'pos:layoutChanged' ||
    eventName === 'pos:tableMergesChanged'
  ) {
    invalidateFloorSnapshots();
    return;
  }

  if (eventName === 'pos:settingsChanged') {
    // Drop the full settings cache so the next get() is live. Do not write
    // this slim payload into POS_CACHE.settings — that blob would look like
    // a hydrated document and turn clock back on.
    invalidateCache(POS_CACHE.settings);
    applyHostPosUiTheme(themeFromChange(payload));
  }
}

let installed = false;

export function installPosRealtimeSync(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  installed = true;

  const onEvent = (eventName: PosRealtimeEventName) => (ev: Event) => {
    applyPosRealtimeEvent(eventName, (ev as CustomEvent).detail);
  };

  window.addEventListener('pos:tablesChanged', onEvent('pos:tablesChanged'));
  window.addEventListener('pos:ticketsChanged', onEvent('pos:ticketsChanged'));
  window.addEventListener('pos:layoutChanged', onEvent('pos:layoutChanged'));
  window.addEventListener(
    'pos:tableMergesChanged',
    onEvent('pos:tableMergesChanged'),
  );
  window.addEventListener(
    'pos:settingsChanged',
    onEvent('pos:settingsChanged'),
  );
  // Visibility catchup lives in main.tsx (gated on a dead SSE socket).
  // Electron still pings this after OS sleep.
  window.addEventListener('pos:os-resume', () => emitPosSyncCatchupSoon());
}

/** @internal vitest */
export function resetPosRealtimeSyncForTests(): void {
  installed = false;
}
