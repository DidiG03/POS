/**
 * Wrap `window.api` reads with stale-while-revalidate so every screen
 * shares one cache: Tables, Order, Login, and the boot gate all see the
 * same last-good menu / settings / floor instead of each firing their
 * own round-trip.
 *
 * Electron's `contextBridge.exposeInMainWorld` freezes `window.api`. Never
 * assign onto that object — it throws and kills the renderer. The browser
 * / Capacitor polyfill is a plain object; wrap that in place. Frozen IPC
 * still has to ingest floor bills: call `readFloorSnapshot`, do not rely
 * on wrapping `getFloorSnapshot`.
 */
import type { FloorSnapshot, FloorTableSnapshot } from '@shared/ipc';
import { saneTableAreas } from '@shared/tableAreas';
import { asTicketLogItems } from '@shared/ticketLogItems';
import { useSessionStore } from '../stores/session';
import {
  invalidateCache,
  invalidateCachePrefix,
  patchCacheValue,
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
  layout: (area: string) => `pos:layout:${area || '_all'}`,
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

export function peekLayout(area: string): unknown[] | undefined {
  const saved = peek<unknown>(POS_CACHE.layout(String(area || '')));
  return Array.isArray(saved) ? saved : undefined;
}

/**
 * Floor furniture barely changes. Serve the last saved nodes immediately
 * and refresh in the background so a waiter is not stuck on a 10s GET
 * spinner every time Tables mounts.
 */
export async function readLayout(
  area: string,
  opts?: { userId?: number; scope?: string },
): Promise<unknown[] | null> {
  const name = String(area || '').trim();
  if (!name) return [];
  if (typeof window === 'undefined') return peekLayout(name) ?? null;
  const fn = (window as any).api?.layout?.get;
  if (typeof fn !== 'function') return peekLayout(name) ?? null;
  try {
    const nodes = await swr(
      POS_CACHE.layout(name),
      async () => {
        const raw = await fn(opts?.userId ?? 0, name, opts?.scope);
        return Array.isArray(raw) ? raw : [];
      },
      { maxAgeMs: 60_000 },
    );
    return Array.isArray(nodes) ? nodes : [];
  } catch {
    return peekLayout(name) ?? null;
  }
}

export function invalidateLayoutCache(area?: string): void {
  const name = String(area || '').trim();
  if (name) {
    invalidateCache(POS_CACHE.layout(name));
    return;
  }
  invalidateCachePrefix('pos:layout:');
}

export function cacheLatestTicket(
  area: string,
  label: string,
  data: unknown,
): void {
  writeCache(POS_CACHE.ticket(area, label), data);
}

let lastIngestedSnap: FloorSnapshot | null = null;
let lastIngestedOpts = '';

function ingestOptsKey(opts?: { mergeOpen?: boolean; area?: string }): string {
  return `${opts?.mergeOpen ? 1 : 0}:${opts && 'area' in opts ? String(opts.area || '') : '*'}`;
}

export function ingestFloorSnapshot(
  snap: FloorSnapshot | null | undefined,
  opts?: { mergeOpen?: boolean; area?: string },
): void {
  if (!snap || !Array.isArray(snap.tables)) return;
  if (snap === lastIngestedSnap && ingestOptsKey(opts) === lastIngestedOpts) {
    return;
  }
  lastIngestedSnap = snap;
  lastIngestedOpts = ingestOptsKey(opts);
  const scopeArea = opts && 'area' in opts ? String(opts.area || '') : '';
  if (opts && 'area' in opts) {
    const prevSnap = peekFloorSnapshot(scopeArea);
    const nextKeys = new Set(
      snap.tables.map((row) => `${row.area}:${row.label}`),
    );
    if (prevSnap && Array.isArray(prevSnap.tables)) {
      for (const row of prevSnap.tables) {
        if (!nextKeys.has(`${row.area}:${row.label}`)) {
          invalidateCache(POS_CACHE.ticket(row.area, row.label));
        }
      }
    }
    writeCache(POS_CACHE.floor(scopeArea), snap);
  }
  const open: Array<{ area: string; label: string }> = [];
  for (const row of snap.tables) {
    open.push({ area: row.area, label: row.label });
    const items = asTicketLogItems(row.items);
    if (items.length > 0) {
      cacheLatestTicket(row.area, row.label, {
        items,
        note: row.note,
        covers: row.covers,
        createdAt: row.openedAt || new Date().toISOString(),
        userId: row.userId,
      });
    }
  }
  if (opts?.mergeOpen) {
    const prev = peek<Array<{ area: string; label: string }>>(
      POS_CACHE.openTables,
    );
    const areas = new Set(open.map((t) => t.area));
    if (scopeArea) areas.add(scopeArea);
    const kept = (Array.isArray(prev) ? prev : []).filter(
      (t) => !areas.has(t.area),
    );
    writeCache(POS_CACHE.openTables, [...kept, ...open]);
    return;
  }
  writeCache(POS_CACHE.openTables, open);
}

/**
 * Fetch the floor snapshot and copy any bills into the ticket cache.
 * Safe on Electron (frozen bridge) and on tablets (writable polyfill).
 */
export async function readFloorSnapshot(
  area?: string,
): Promise<FloorSnapshot | null> {
  if (typeof window === 'undefined') return null;
  const fn = (window as any).api?.tables?.getFloorSnapshot;
  if (typeof fn !== 'function') return null;
  try {
    const snap = (await fn(area)) as FloorSnapshot;
    if (!snap || !Array.isArray(snap.tables)) return null;
    ingestFloorSnapshot(snap, {
      mergeOpen: Boolean(area),
      area: String(area || ''),
    });
    return snap;
  } catch {
    return null;
  }
}

export function prefetchHotReads(): void {
  if (typeof window === 'undefined') return;
  const session = useSessionStore.getState();
  if (!session.user || !session.sessionToken) return;
  const api = (window as any).api;
  if (!api) return;
  // Floor already loaded settings + users. Warm the menu for the first
  // ticket without kicking those two reads into another soft-revalidate.
  void api.menu?.listCategoriesWithItems?.().catch(() => undefined);
  const areas = saneTableAreas(peekSettings<any>()?.tableAreas);
  for (const row of areas.slice(0, 6)) {
    const name = String(row?.name || '').trim();
    if (name) void readLayout(name).catch(() => undefined);
  }
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
  opts?: { waitIfStale?: boolean },
): void {
  if (!obj || typeof obj[method] !== 'function') return;
  if (!isWritable(obj, method)) return;
  const orig = obj[method].bind(obj);
  try {
    obj[method] = (...args: any[]) =>
      swr(keyFn(...args), () => orig(...args), {
        maxAgeMs,
        waitIfStale: opts?.waitIfStale,
      });
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
  wrapMethod(api.settings, 'get', () => POS_CACHE.settings, 20_000, {
    waitIfStale: true,
  });
  wrapMethod(api.menu, 'listCategoriesWithItems', () => POS_CACHE.menu, 45_000);
  wrapMethod(api.auth, 'listUsers', () => POS_CACHE.users, 60_000);
  wrapMethod(api.tables, 'listOpen', () => POS_CACHE.openTables, 4_000);
  wrapMethod(
    api.layout,
    'get',
    (_userId: unknown, area: unknown) => POS_CACHE.layout(String(area || '')),
    60_000,
  );

  wrapAfter(api.settings, 'update', () => {
    invalidateCache(POS_CACHE.settings);
  });

  wrapAfter(api.layout, 'save', (_r, args) => {
    const area = String(args[1] || '');
    const nodes = args[2];
    if (area && Array.isArray(nodes)) writeCache(POS_CACHE.layout(area), nodes);
  });

  wrapAfter(api.tables, 'setOpen', (_r, args) => {
    applyLiveTableEvent({
      area: String(args[0] || ''),
      label: String(args[1] || ''),
      open: Boolean(args[2]),
    });
  });

  wrapAfter(api.tables, 'transfer', (_r, args) => {
    const p = args[0] || {};
    const fromArea = String(p.fromArea || '');
    const fromLabel = String(p.fromLabel || '');
    const toArea = String(p.toArea || '');
    const toLabel = String(p.toLabel || '');
    if (fromArea && fromLabel) {
      applyLiveTableEvent({ area: fromArea, label: fromLabel, open: false });
    }
    if (toArea && toLabel) {
      applyLiveTableEvent({
        area: toArea,
        label: toLabel,
        open: true,
        userId: Number(p.toUserId || p.actorUserId || 0) || null,
      });
    }
  });

  const noteTicketWrite = (_r: unknown, args: any[]) => {
    const p = args[0] || {};
    const area = String(p.area || '');
    const label = String(p.tableLabel || p.label || '');
    if (!area || !label) return;
    invalidateTicketCache(area, label);
    applyLiveTableEvent({
      area,
      label,
      userId: Number(p.userId || p.meta?.userId || 0) || null,
    });
  };
  wrapAfter(api.tickets, 'log', noteTicketWrite);
  wrapAfter(api.tickets, 'voidItem', noteTicketWrite);
  wrapAfter(api.tickets, 'voidTicket', noteTicketWrite);
  wrapAfter(api.tickets, 'print', noteTicketWrite);

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
        ingestFloorSnapshot(snap, {
          mergeOpen: Boolean(area),
          area: String(area || ''),
        });
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

let catchupSoonTimer: ReturnType<typeof setTimeout> | null = null;
let lastCatchupAt = 0;
const CATCHUP_DEBOUNCE_MS = 8_000;

/** @internal vitest */
export function resetPosReadCacheForTests(): void {
  installed = false;
  lastCatchupAt = 0;
  lastIngestedSnap = null;
  lastIngestedOpts = '';
  if (catchupSoonTimer != null) {
    clearTimeout(catchupSoonTimer);
    catchupSoonTimer = null;
  }
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

function patchOpenTables(
  area: string,
  label: string,
  open: boolean,
): void {
  const prev = peek<Array<{ area: string; label: string }>>(POS_CACHE.openTables);
  const rows = Array.isArray(prev) ? prev : [];
  const has = rows.some((t) => t.area === area && t.label === label);
  if (open) {
    if (has) return;
    writeCache(POS_CACHE.openTables, [...rows, { area, label }]);
    return;
  }
  if (!has) return;
  writeCache(
    POS_CACHE.openTables,
    rows.filter((t) => !(t.area === area && t.label === label)),
  );
}

function patchFloorTables(
  scope: string,
  mutate: (tables: FloorTableSnapshot[]) => FloorTableSnapshot[] | undefined,
): void {
  patchCacheValue<FloorSnapshot>(POS_CACHE.floor(scope), (snap) => {
    if (!snap || !Array.isArray(snap.tables)) return undefined;
    const next = mutate(snap.tables);
    if (!next) return undefined;
    return { tables: next };
  });
}

/**
 * Apply a live occupancy event from SSE / IPC without dropping every
 * waiter's floor cache. One Send used to wipe `pos:floor:*` on every
 * phone, then ten tablets refetched SQLite at once.
 */
export function applyLiveTableEvent(input: {
  area: string;
  label: string;
  open?: boolean;
  userId?: number | null;
}): void {
  const area = String(input.area || '').trim();
  const label = String(input.label || '').trim();
  if (!area || !label) return;
  const scopes = [area, ''];

  if (input.open === false) {
    invalidateTicketCache(area, label);
    patchOpenTables(area, label, false);
    for (const scope of scopes) {
      patchFloorTables(scope, (tables) => {
        const next = tables.filter(
          (row) => !(row.area === area && row.label === label),
        );
        return next.length === tables.length ? undefined : next;
      });
    }
    lastIngestedSnap = null;
    lastIngestedOpts = '';
    return;
  }

  if (input.open === true) {
    patchOpenTables(area, label, true);
    for (const scope of scopes) {
      patchFloorTables(scope, (tables) => {
        if (tables.some((row) => row.area === area && row.label === label)) {
          return undefined;
        }
        return [
          ...tables,
          {
            area,
            label,
            openedAt: new Date().toISOString(),
            userId: input.userId ?? null,
            covers: null,
            total: 0,
            items: [],
            note: null,
          },
        ];
      });
    }
    lastIngestedSnap = null;
    lastIngestedOpts = '';
    return;
  }

  const uid = Number(input.userId);
  if (!Number.isFinite(uid) || uid <= 0) return;
  for (const scope of scopes) {
    patchFloorTables(scope, (tables) => {
      const idx = tables.findIndex(
        (row) => row.area === area && row.label === label,
      );
      if (idx < 0) return undefined;
      if (tables[idx].userId === uid) return undefined;
      const next = tables.slice();
      next[idx] = { ...tables[idx], userId: uid };
      return next;
    });
  }
}

/** Tablets missed SSE while backgrounded — drop caches and tell every screen to refetch. */
export function emitPosSyncCatchup(): void {
  lastCatchupAt = Date.now();
  invalidateFloorCache();
  invalidateCache(POS_CACHE.settings);
  invalidateCache(POS_CACHE.users);
  try {
    window.dispatchEvent(new CustomEvent('pos:syncCatchup'));
  } catch {
    // ignore
  }
}

/** Phone picked a different till — drop host-specific reads before reconnecting. */
export function invalidateHostScopedCaches(): void {
  invalidateCache(POS_CACHE.settings);
  invalidateCache(POS_CACHE.menu);
  invalidateCache(POS_CACHE.users);
  emitPosSyncCatchup();
}

/** Coalesce bursty parse/reconnect misses into one refetch. */
export function emitPosSyncCatchupSoon(delayMs = 400): void {
  if (typeof window === 'undefined') return;
  if (catchupSoonTimer != null) return;
  if (Date.now() - lastCatchupAt < CATCHUP_DEBOUNCE_MS) return;
  catchupSoonTimer = setTimeout(() => {
    catchupSoonTimer = null;
    emitPosSyncCatchup();
  }, delayMs);
}
