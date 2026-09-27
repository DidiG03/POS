/**
 * Floor occupancy: one SQLite row per open table.
 *
 * The previous `tables:open` / `tables:openAt` SyncState JSON maps were a
 * single-column read-modify-write. Two waiters opening different tables
 * could both read the same blob and the later write dropped the earlier
 * table. Per-table mutexes did not help — they only serialize one table.
 *
 * Occupied = a row exists. `openedAt` is the sitting start and is not
 * reset on a repeated open of an already-open table.
 */
import { prisma } from '@db/client';
import { coalesceInflight } from '@shared/asyncMutex';
import { splitTableKey, tableKey } from '@shared/utils/tableKey';

const LEGACY_OPEN_KEY = 'tables:open';
const LEGACY_OPEN_AT_KEY = 'tables:openAt';
const MIGRATED_KEY = 'tables:occupancyMigrated';
/** Tap-time of the latest open/close that actually landed, per table. */
const LAST_INTENT_KEY = 'tables:lastIntentAt';
const INTENT_RETAIN_MS = 2 * 24 * 60 * 60 * 1000;
const occupiedInflight = new Map<string, Promise<OccupiedTable[]>>();
let intentCache: Record<string, number> | null = null;

export type OccupiedTable = {
  area: string;
  label: string;
  openedAt: Date;
};

type OccupancyClient = {
  tableOccupancy: {
    findMany: (args?: unknown) => Promise<any[]>;
    findUnique: (args: unknown) => Promise<any>;
    upsert: (args: unknown) => Promise<any>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    count: (args?: unknown) => Promise<number>;
  };
  syncState: {
    findUnique: (args: unknown) => Promise<any>;
    upsert: (args: unknown) => Promise<any>;
  };
};

function db(client?: OccupancyClient): OccupancyClient {
  return (client || (prisma as unknown as OccupancyClient)) as OccupancyClient;
}

function asOpenedAt(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const t = new Date(value as any);
  return Number.isFinite(t.getTime()) ? t : new Date();
}

function rowToOccupied(row: {
  area?: string;
  label?: string;
  openedAt?: unknown;
}): OccupiedTable | null {
  const area = String(row?.area || '').trim();
  const label = String(row?.label || '').trim();
  if (!area || !label) return null;
  return { area, label, openedAt: asOpenedAt(row.openedAt) };
}

let migratedThisProcess = false;

async function markMigrated(client: OccupancyClient): Promise<void> {
  migratedThisProcess = true;
  await client.syncState
    .upsert({
      where: { key: MIGRATED_KEY },
      create: { key: MIGRATED_KEY, valueJson: true },
      update: { valueJson: true },
    })
    .catch(() => {
      migratedThisProcess = false;
    });
}

async function importLegacyMaps(client: OccupancyClient): Promise<void> {
  const [openRow, atRow] = await Promise.all([
    client.syncState
      .findUnique({ where: { key: LEGACY_OPEN_KEY } })
      .catch(() => null),
    client.syncState
      .findUnique({ where: { key: LEGACY_OPEN_AT_KEY } })
      .catch(() => null),
  ]);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<
    string,
    boolean
  >;
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;

  for (const [k, open] of Object.entries(openMap)) {
    if (!open) continue;
    const parts = splitTableKey(k);
    if (!parts) continue;
    const iso = atMap[k];
    const openedAt = iso ? asOpenedAt(iso) : new Date();
    await client.tableOccupancy
      .upsert({
        where: {
          area_label: { area: parts.area, label: parts.label },
        },
        create: {
          area: parts.area,
          label: parts.label,
          openedAt,
        },
        update: {},
      })
      .catch(() => null);
  }
}

/**
 * Copy leftover JSON occupancy into rows once, then never read those maps
 * again. Safe to call on every occupancy read: empty restaurants skip
 * after the migrated flag is set.
 */
export async function backfillTableOccupancyFromSyncState(
  client?: OccupancyClient,
): Promise<void> {
  if (migratedThisProcess) return;
  const c = db(client);
  try {
    const flag = await c.syncState
      .findUnique({ where: { key: MIGRATED_KEY } })
      .catch(() => null);
    if (flag?.valueJson) {
      migratedThisProcess = true;
      return;
    }
    const n = await c.tableOccupancy.count().catch(() => 0);
    if (n === 0) await importLegacyMaps(c);
    await markMigrated(c);
  } catch {
    // Table missing until migration/ensureLocalDbColumns runs; next call retries.
  }
}

/** Test-only: allow a second backfill in the same process. */
export function resetOccupancyImportLatchForTests(): void {
  migratedThisProcess = false;
}

/** Test-only: drop the in-memory open/close ordering cache. */
export function resetOccupancyIntentCacheForTests(): void {
  intentCache = null;
}

function pruneIntents(
  map: Record<string, number>,
  now: number,
): Record<string, number> {
  const cutoff = now - INTENT_RETAIN_MS;
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(map)) {
    const n = Number(at);
    if (!key || !Number.isFinite(n) || n < cutoff) continue;
    next[key] = n;
  }
  return next;
}

async function intentMap(
  client: OccupancyClient,
): Promise<Record<string, number>> {
  if (intentCache) return intentCache;
  const row = await client.syncState
    .findUnique({ where: { key: LAST_INTENT_KEY } })
    .catch(() => null);
  const raw = ((row?.valueJson as Record<string, number>) || {}) as Record<
    string,
    number
  >;
  intentCache = pruneIntents(raw, Date.now());
  return intentCache;
}

async function commitIntent(
  client: OccupancyClient,
  area: string,
  label: string,
  intentAt: number,
): Promise<void> {
  const map = await intentMap(client);
  const key = tableKey(area, label);
  const prev = Number(map[key] || 0);
  if (!(intentAt > prev)) return;
  map[key] = intentAt;
  const pruned = pruneIntents(map, Date.now());
  intentCache = pruned;
  await client.syncState
    .upsert({
      where: { key: LAST_INTENT_KEY },
      create: { key: LAST_INTENT_KEY, valueJson: pruned },
      update: { valueJson: pruned },
    })
    .catch(() => undefined);
}

/**
 * Ignore a client open/close that was tapped before a newer one already
 * landed. Missing `intentAt` is a host-side write (ticket log, void, pay)
 * and always applies — those must still be able to open a table the
 * queue had already marked closed.
 */
export async function occupancyIntentIsStale(
  area: string,
  label: string,
  intentAt: number | null | undefined,
  client?: OccupancyClient,
): Promise<boolean> {
  const intent = Number(intentAt);
  if (!area || !label || !Number.isFinite(intent) || intent <= 0) return false;
  const map = await intentMap(db(client));
  return Number(map[tableKey(area, label)] || 0) > intent;
}

export async function listOccupiedTables(
  client?: OccupancyClient,
): Promise<OccupiedTable[]> {
  await backfillTableOccupancyFromSyncState(client);
  if (client) return readOccupiedRows(client);
  return coalesceInflight(occupiedInflight, '*', () => readOccupiedRows(db()));
}

async function readOccupiedRows(
  client: OccupancyClient,
): Promise<OccupiedTable[]> {
  const rows = await client.tableOccupancy.findMany().catch(() => []);
  const out: OccupiedTable[] = [];
  for (const row of rows) {
    const parsed = rowToOccupied(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function occupancyMaps(client?: OccupancyClient): Promise<{
  open: Record<string, boolean>;
  openAt: Record<string, string>;
}> {
  const tables = await listOccupiedTables(client);
  const open: Record<string, boolean> = {};
  const openAt: Record<string, string> = {};
  for (const t of tables) {
    const k = tableKey(t.area, t.label);
    open[k] = true;
    openAt[k] = t.openedAt.toISOString();
  }
  return { open, openAt };
}

export async function countOccupiedTables(
  client?: OccupancyClient,
): Promise<number> {
  await backfillTableOccupancyFromSyncState(client);
  return db(client)
    .tableOccupancy.count()
    .catch(() => 0);
}

export async function isTableOccupied(
  area: string,
  label: string,
  client?: OccupancyClient,
): Promise<boolean> {
  if (!area || !label) return false;
  await backfillTableOccupancyFromSyncState(client);
  const row = await db(client)
    .tableOccupancy.findUnique({
      where: { area_label: { area, label } },
    })
    .catch(() => null);
  return Boolean(row);
}

export async function getOpenedAt(
  area: string,
  label: string,
  client?: OccupancyClient,
): Promise<Date | null> {
  if (!area || !label) return null;
  await backfillTableOccupancyFromSyncState(client);
  const row = await db(client)
    .tableOccupancy.findUnique({
      where: { area_label: { area, label } },
    })
    .catch(() => null);
  if (!row) return null;
  const openedAt = asOpenedAt(row.openedAt);
  return Number.isFinite(openedAt.getTime()) ? openedAt : null;
}

/**
 * Open or close one table. A repeated open leaves `openedAt` unchanged
 * so session-bounded ticket queries stay on the same sitting.
 *
 * `intentAt` is the tap on the till's clock. Phones send how long ago
 * they tapped, and the host converts that before calling here. A slow
 * `open: true` that was tapped before Pay must not paint the table red
 * again with nothing on it but the sitting timer.
 *
 * Returns false when the write is ignored as stale.
 */
export async function setTableOccupied(
  area: string,
  label: string,
  open: boolean,
  client?: OccupancyClient,
  options?: { intentAt?: number | null },
): Promise<boolean> {
  if (!area || !label) return false;
  await backfillTableOccupancyFromSyncState(client);
  const c = db(client);
  const explicit = Number(options?.intentAt);
  const hasExplicit = Number.isFinite(explicit) && explicit > 0;
  if (hasExplicit && (await occupancyIntentIsStale(area, label, explicit, c))) {
    return false;
  }
  if (open) {
    await c.tableOccupancy.upsert({
      where: { area_label: { area, label } },
      create: { area, label, openedAt: new Date() },
      update: {},
    });
  } else {
    await c.tableOccupancy.deleteMany({ where: { area, label } });
  }
  await commitIntent(c, area, label, hasExplicit ? explicit : Date.now());
  return true;
}

export class DestinationTableOccupiedError extends Error {
  readonly code = 'DEST_OPEN';
  constructor(area: string, label: string) {
    super(`Destination table ${area} ${label} is already open`);
    this.name = 'DestinationTableOccupiedError';
  }
}

/** Move a sitting from one table key to another without resetting openedAt. */
export async function moveTableOccupancy(
  fromArea: string,
  fromLabel: string,
  toArea: string,
  toLabel: string,
  client?: OccupancyClient,
): Promise<void> {
  if (!fromArea || !fromLabel || !toArea || !toLabel) return;
  await backfillTableOccupancyFromSyncState(client);
  const c = db(client);
  const same = fromArea === toArea && fromLabel === toLabel;
  if (same) {
    const existing = await c.tableOccupancy
      .findUnique({
        where: { area_label: { area: fromArea, label: fromLabel } },
      })
      .catch(() => null);
    if (!existing) {
      await c.tableOccupancy.upsert({
        where: { area_label: { area: fromArea, label: fromLabel } },
        create: { area: fromArea, label: fromLabel, openedAt: new Date() },
        update: {},
      });
    }
    return;
  }

  const dest = await c.tableOccupancy
    .findUnique({
      where: { area_label: { area: toArea, label: toLabel } },
    })
    .catch(() => null);
  if (dest) throw new DestinationTableOccupiedError(toArea, toLabel);

  const src = await c.tableOccupancy
    .findUnique({
      where: { area_label: { area: fromArea, label: fromLabel } },
    })
    .catch(() => null);
  const openedAt = src ? asOpenedAt(src.openedAt) : new Date();

  await c.tableOccupancy.deleteMany({
    where: { area: fromArea, label: fromLabel },
  });
  await c.tableOccupancy.upsert({
    where: { area_label: { area: toArea, label: toLabel } },
    create: { area: toArea, label: toLabel, openedAt },
    update: { openedAt },
  });
  // A slow open of the table we just left must not bring that sitting back.
  const movedAt = Date.now();
  await commitIntent(c, fromArea, fromLabel, movedAt);
  await commitIntent(c, toArea, toLabel, movedAt);
}
