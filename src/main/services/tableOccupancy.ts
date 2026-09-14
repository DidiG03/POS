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
const occupiedInflight = new Map<string, Promise<OccupiedTable[]>>();

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
 */
export async function setTableOccupied(
  area: string,
  label: string,
  open: boolean,
  client?: OccupancyClient,
): Promise<void> {
  if (!area || !label) return;
  await backfillTableOccupancyFromSyncState(client);
  const c = db(client);
  if (open) {
    await c.tableOccupancy.upsert({
      where: { area_label: { area, label } },
      create: { area, label, openedAt: new Date() },
      update: {},
    });
    return;
  }
  await c.tableOccupancy.deleteMany({ where: { area, label } });
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
}
