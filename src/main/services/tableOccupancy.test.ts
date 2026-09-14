/**
 * Occupancy is one row per open table so two waiters opening T1 and T2
 * cannot clobber each other the way the old SyncState JSON maps did.
 *
 * Run with: pnpm test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  area: string;
  label: string;
  openedAt: Date;
};

const { fake } = vi.hoisted(() => {
  const keyOf = (area: string, label: string) => `${area}\0${label}`;
  const rows = new Map<string, Row>();
  const sync = new Map<string, unknown>();
  const fake = {
    rows,
    sync,
    tableOccupancy: {
      findMany: async () => [...rows.values()],
      count: async () => rows.size,
      findUnique: async ({ where }: any) => {
        const { area, label } = where.area_label;
        return rows.get(keyOf(area, label)) ?? null;
      },
      upsert: async ({ where, create, update }: any) => {
        const { area, label } = where.area_label;
        const k = keyOf(area, label);
        const existing = rows.get(k);
        if (!existing) {
          const row: Row = {
            area: create.area,
            label: create.label,
            openedAt: create.openedAt ?? new Date(),
          };
          rows.set(k, row);
          return row;
        }
        if (update && Object.keys(update).length) {
          const next = { ...existing, ...update };
          rows.set(k, next);
          return next;
        }
        return existing;
      },
      deleteMany: async ({ where }: any) => {
        const k = keyOf(where.area, where.label);
        const had = rows.delete(k);
        return { count: had ? 1 : 0 };
      },
    },
    syncState: {
      findUnique: async ({ where }: any) => {
        if (!sync.has(where.key)) return null;
        return { key: where.key, valueJson: sync.get(where.key) };
      },
      upsert: async ({ where, create, update }: any) => {
        const value = update?.valueJson ?? create?.valueJson;
        sync.set(where.key, value);
        return { key: where.key, valueJson: value };
      },
    },
  };
  return { fake };
});

vi.mock('@db/client', () => ({
  prisma: fake,
}));

import {
  backfillTableOccupancyFromSyncState,
  countOccupiedTables,
  DestinationTableOccupiedError,
  getOpenedAt,
  isTableOccupied,
  listOccupiedTables,
  moveTableOccupancy,
  occupancyMaps,
  resetOccupancyImportLatchForTests,
  setTableOccupied,
} from './tableOccupancy';

describe('tableOccupancy', () => {
  beforeEach(() => {
    fake.rows.clear();
    fake.sync.clear();
    fake.sync.set('tables:occupancyMigrated', true);
    resetOccupancyImportLatchForTests();
  });

  it('keeps both tables when two waiters open at the same time', async () => {
    await Promise.all([
      setTableOccupied('Sallon', 'T1', true),
      setTableOccupied('Sallon', 'T2', true),
    ]);
    const listed = await listOccupiedTables();
    const keys = listed.map((t) => `${t.area}:${t.label}`).sort();
    expect(keys).toEqual(['Sallon:T1', 'Sallon:T2']);
    expect(await countOccupiedTables()).toBe(2);
  });

  it('does not reset openedAt when the same table is opened again', async () => {
    await setTableOccupied('Bar', 'B1', true);
    const first = await getOpenedAt('Bar', 'B1');
    expect(first).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 15));
    await setTableOccupied('Bar', 'B1', true);
    const second = await getOpenedAt('Bar', 'B1');
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it('removes only the closed table', async () => {
    await setTableOccupied('Sallon', 'T1', true);
    await setTableOccupied('Sallon', 'T2', true);
    await setTableOccupied('Sallon', 'T1', false);
    expect(await isTableOccupied('Sallon', 'T1')).toBe(false);
    expect(await isTableOccupied('Sallon', 'T2')).toBe(true);
    const maps = await occupancyMaps();
    expect(maps.open).toEqual({ 'Sallon:T2': true });
    expect(maps.openAt['Sallon:T2']).toEqual(expect.any(String));
  });

  it('moves a sitting to a new table and keeps openedAt', async () => {
    await setTableOccupied('Sallon', 'T1', true);
    const started = await getOpenedAt('Sallon', 'T1');
    await moveTableOccupancy('Sallon', 'T1', 'Sallon', 'T9');
    expect(await isTableOccupied('Sallon', 'T1')).toBe(false);
    expect(await isTableOccupied('Sallon', 'T9')).toBe(true);
    expect((await getOpenedAt('Sallon', 'T9'))?.getTime()).toBe(
      started?.getTime(),
    );
  });

  it('refuses to move onto an already-open destination', async () => {
    await setTableOccupied('Sallon', 'T1', true);
    await setTableOccupied('Sallon', 'T2', true);
    await expect(
      moveTableOccupancy('Sallon', 'T1', 'Sallon', 'T2'),
    ).rejects.toBeInstanceOf(DestinationTableOccupiedError);
    expect(await isTableOccupied('Sallon', 'T1')).toBe(true);
  });

  it('imports leftover SyncState JSON maps once on upgrade', async () => {
    fake.sync.clear();
    fake.sync.set('tables:open', { 'Sallon:T4': true, 'Bar:B2': true });
    fake.sync.set('tables:openAt', {
      'Sallon:T4': '2026-09-12T10:00:00.000Z',
    });
    resetOccupancyImportLatchForTests();

    await backfillTableOccupancyFromSyncState();
    const listed = await listOccupiedTables();
    expect(listed).toHaveLength(2);
    const t4 = listed.find((t) => t.label === 'T4');
    expect(t4?.openedAt.toISOString()).toBe('2026-09-12T10:00:00.000Z');

    fake.sync.set('tables:open', { 'Ghost:T9': true });
    resetOccupancyImportLatchForTests();
    await backfillTableOccupancyFromSyncState();
    const after = await listOccupiedTables();
    expect(after.some((t) => t.label === 'T9')).toBe(false);
    expect(after).toHaveLength(2);
  });
});
