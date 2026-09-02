/**
 * Wrap `window.api` reads with stale-while-revalidate so every screen
 * shares one cache: Tables, Order, Login, and the boot gate all see the
 * same last-good menu / settings / floor instead of each firing their
 * own round-trip.
 *
 * Electron's `contextBridge.exposeInMainWorld` freezes `window.api`. Never
 * assign onto that object — it throws and kills the renderer. The browser
 * / Capacitor polyfill is a plain object; wrap that in place. Host IPC is
 * local SQLite, so skipping the wrap there is fine.
 */
import type { FloorSnapshot } from '@shared/ipc';
import {
  invalidateCache,
  invalidateCachePrefix,
  peek,
  swr,
  writeCache,
} from './swrCache';

export const POS_CACHE = {
  settings: 'pos:settings',
  menu: 'pos:menu',
  users: 'pos:users',
  openTables: 'pos:open-tables',
  floor: (area: string) => `pos:floor:${area || '_all'}`,
  ticket: (area: string, label: string) => `pos:ticket:${area}:${label}`,
};

let installed = false;

export function peekSettings<T = any>(): T | undefined {
  return peek<T>(POS_CACHE.settings);
}

export function peekMenu<T = any>(): T | undefined {
  return peek<T>(POS_CACHE.menu);
}

export function peekFloorSnapshot(area: string): FloorSnapshot | undefined {
  return peek<FloorSnapshot>(POS_CACHE.floor(area));
}

export function peekLatestTicket(area: string, label: string): any | undefined {
  return peek(POS_CACHE.ticket(area, label));
}

export function cacheLatestTicket(
  area: string,
  label: string,
  data: unknown,
): void {
  writeCache(POS_CACHE.ticket(area, label), data);
}

export function ingestFloorSnapshot(
  snap: FloorSnapshot | null | undefined,
  opts?: { mergeOpen?: boolean },
): void {
  if (!snap || !Array.isArray(snap.tables)) return;
  const open: Array<{ area: string; label: string }> = [];
  for (const row of snap.tables) {
    open.push({ area: row.area, label: row.label });
    cacheLatestTicket(row.area, row.label, {
      items: row.items,
      note: row.note,
      covers: row.covers,
      createdAt: row.openedAt || new Date().toISOString(),
      userId: row.userId,
    });
  }
  if (opts?.mergeOpen) {
    const prev = peek<Array<{ area: string; label: string }>>(
      POS_CACHE.openTables,
    );
    const areas = new Set(open.map((t) => t.area));
    const kept = (Array.isArray(prev) ? prev : []).filter(
      (t) => !areas.has(t.area),
    );
    writeCache(POS_CACHE.openTables, [...kept, ...open]);
    return;
  }
  writeCache(POS_CACHE.openTables, open);
}

export function prefetchHotReads(): void {
  if (typeof window === 'undefined') return;
  const api = (window as any).api;
  if (!api) return;
  void api.menu?.listCategoriesWithItems?.().catch(() => undefined);
  void api.settings?.get?.().catch(() => undefined);
  void api.auth?.listUsers?.().catch(() => undefined);
}

function isWritable(obj: any, key: string): boolean {
  if (!obj) return false;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) {
      return Object.isExtensible(obj);
    }
    return Boolean(desc.writable || desc.set);
  } catch {
    return false;
  }
}

function wrapMethod(
  obj: any,
  method: string,
  keyFn: (...args: any[]) => string,
  maxAgeMs: number,
): void {
  if (!obj || typeof obj[method] !== 'function') return;
  if (!isWritable(obj, method)) return;
  const orig = obj[method].bind(obj);
  try {
    obj[method] = (...args: any[]) =>
      swr(keyFn(...args), () => orig(...args), { maxAgeMs });
  } catch {
    // Frozen bridge — leave the original IPC method alone.
  }
}

function wrapAfter(
  obj: any,
  method: string,
  after: (result: any, args: any[]) => void,
): void {
  if (!obj || typeof obj[method] !== 'function') return;
  if (!isWritable(obj, method)) return;
  const orig = obj[method].bind(obj);
  try {
    obj[method] = async (...args: any[]) => {
      const r = await orig(...args);
      after(r, args);
      return r;
    };
  } catch {
    // Frozen bridge
  }
}

function applyReadWraps(api: any): void {
  wrapMethod(api.settings, 'get', () => POS_CACHE.settings, 20_000);
  wrapMethod(api.menu, 'listCategoriesWithItems', () => POS_CACHE.menu, 45_000);
  wrapMethod(api.auth, 'listUsers', () => POS_CACHE.users, 60_000);
  wrapMethod(api.tables, 'listOpen', () => POS_CACHE.openTables, 4_000);
  wrapMethod(
    api.tickets,
    'getLatestForTable',
    (area: string, label: string) =>
      POS_CACHE.ticket(String(area), String(label)),
    8_000,
  );

  wrapAfter(api.settings, 'update', () => {
    invalidateCache(POS_CACHE.settings);
  });

  wrapAfter(api.tables, 'setOpen', (_r, args) => {
    const area = args[0];
    const label = args[1];
    const open = args[2];
    if (!open && area && label) {
      invalidateTicketCache(String(area), String(label));
      invalidateCachePrefix('pos:floor:');
    }
  });

  wrapAfter(api.tables, 'transfer', (_r, args) => {
    const p = args[0] || {};
    const fromArea = String(p.fromArea || '');
    const fromLabel = String(p.fromLabel || '');
    const toArea = String(p.toArea || '');
    const toLabel = String(p.toLabel || '');
    if (fromArea && fromLabel) invalidateTicketCache(fromArea, fromLabel);
    if (toArea && toLabel) invalidateTicketCache(toArea, toLabel);
    invalidateFloorCache();
  });

  const invalidateTicketWrite = (_r: unknown, args: any[]) => {
    const p = args[0] || {};
    const area = String(p.area || '');
    const label = String(p.tableLabel || p.label || '');
    if (area && label) invalidateTicketCache(area, label);
    invalidateCachePrefix('pos:floor:');
    invalidateCache(POS_CACHE.openTables);
  };
  wrapAfter(api.tickets, 'log', invalidateTicketWrite);
  wrapAfter(api.tickets, 'voidItem', invalidateTicketWrite);
  wrapAfter(api.tickets, 'voidTicket', invalidateTicketWrite);
  wrapAfter(api.tickets, 'print', invalidateTicketWrite);

  if (api.menu) {
    for (const m of [
      'createCategory',
      'updateCategory',
      'deleteCategory',
      'createItem',
      'updateItem',
      'deleteItem',
    ]) {
      wrapAfter(api.menu, m, () => {
        invalidateCache(POS_CACHE.menu);
      });
    }
  }

  if (
    api.tables &&
    typeof api.tables.getFloorSnapshot === 'function' &&
    isWritable(api.tables, 'getFloorSnapshot')
  ) {
    const orig = api.tables.getFloorSnapshot.bind(api.tables);
    try {
      api.tables.getFloorSnapshot = async (area?: string) => {
        const snap = (await swr(
          POS_CACHE.floor(String(area || '')),
          () => orig(area),
          { maxAgeMs: 4_000 },
        )) as FloorSnapshot;
        ingestFloorSnapshot(snap, { mergeOpen: Boolean(area) });
        return snap;
      };
    } catch {
      // Frozen bridge
    }
  }
}

export function installPosReadCache(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  const api = (window as any).api;
  if (!api) return;
  installed = true;

  try {
    applyReadWraps(api);
  } catch {
    // Never let cache wiring take down the till.
  }
}

/** @internal vitest */
export function resetPosReadCacheForTests(): void {
  installed = false;
}

export function invalidateTicketCache(area?: string, label?: string): void {
  if (area && label) {
    invalidateCache(POS_CACHE.ticket(area, label));
    return;
  }
  invalidateCachePrefix('pos:ticket:');
}

export function invalidateFloorCache(): void {
  invalidateCachePrefix('pos:floor:');
  invalidateCache(POS_CACHE.openTables);
  invalidateCachePrefix('pos:ticket:');
}

/** Drop floor occupancy snapshots without wiping per-table tickets. */
export function invalidateFloorSnapshots(): void {
  invalidateCachePrefix('pos:floor:');
  invalidateCache(POS_CACHE.openTables);
}
