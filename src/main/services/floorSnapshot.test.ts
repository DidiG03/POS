import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./tableOccupancy', () => ({
  listOccupiedTables: vi.fn(async () => []),
}));

import {
  getFloorSnapshot,
  invalidateFloorSnapshotCache,
  pickLatestPerTable,
  resetFloorSnapshotCacheForTests,
  tableSessionKey,
  ticketRunningTotal,
} from './floorSnapshot';
import { listOccupiedTables, type OccupiedTable } from './tableOccupancy';

describe('ticketRunningTotal', () => {
  it('sums non-voided lines', () => {
    expect(
      ticketRunningTotal([
        { unitPrice: 10, qty: 2 },
        { unitPrice: 5, qty: 1, voided: true },
        { unitPrice: 3, qty: 1 },
      ]),
    ).toBe(23);
  });

  it('returns 0 for an empty ticket', () => {
    expect(ticketRunningTotal([])).toBe(0);
  });
});

describe('pickLatestPerTable', () => {
  const t = <E extends Record<string, unknown>>(
    label: string,
    ms: number,
    extra: E = {} as E,
  ) => ({
    area: 'Sallon',
    tableLabel: label,
    createdAt: new Date(ms),
    ...extra,
  });

  it('keeps the newest row per open table', () => {
    const since = {
      [tableSessionKey('Sallon', 'T1')]: 1000,
      [tableSessionKey('Sallon', 'T2')]: 1000,
    };
    const picked = pickLatestPerTable(
      [
        t('T1', 2000, { id: 1 }),
        t('T1', 3000, { id: 2 }),
        t('T2', 2500, { id: 3 }),
      ],
      since,
    );
    expect(picked.get(tableSessionKey('Sallon', 'T1'))).toMatchObject({
      id: 2,
    });
    expect(picked.get(tableSessionKey('Sallon', 'T2'))).toMatchObject({
      id: 3,
    });
  });

  it('drops rows from a previous session (before openAt)', () => {
    const since = { [tableSessionKey('Sallon', 'T1')]: 5000 };
    const picked = pickLatestPerTable(
      [t('T1', 1000, { id: 'old' }), t('T1', 6000, { id: 'new' })],
      since,
    );
    expect(picked.get(tableSessionKey('Sallon', 'T1'))).toMatchObject({
      id: 'new',
    });
  });

  it('ignores tables that are not in the open map', () => {
    const since = { [tableSessionKey('Sallon', 'T1')]: null };
    const picked = pickLatestPerTable(
      [t('T9', 9000, { id: 'closed' }), t('T1', 1000, { id: 'open' })],
      since,
    );
    expect(picked.size).toBe(1);
    expect(picked.has(tableSessionKey('Sallon', 'T9'))).toBe(false);
  });

  it('reads epoch-ms createdAt from SQLite without throwing', () => {
    const since = { [tableSessionKey('Sallon', 'T1')]: 1_000 };
    const picked = pickLatestPerTable(
      [
        {
          area: 'Sallon',
          tableLabel: 'T1',
          createdAt: 6_000,
          id: 'ms',
        },
      ],
      since,
    );
    expect(picked.get(tableSessionKey('Sallon', 'T1'))).toMatchObject({
      id: 'ms',
    });
  });

  it('still sees a quiet table when busy tables have many newer fires', () => {
    const since: Record<string, number> = {};
    const rows: Array<{
      area: string;
      tableLabel: string;
      createdAt: Date;
      id: string;
    }> = [];
    for (let i = 1; i <= 50; i++) {
      since[tableSessionKey('Sallon', `T${i}`)] = 1;
    }
    for (let n = 0; n < 800; n++) {
      rows.push(t('T1', 10_000 + n, { id: `busy-${n}` }));
    }
    rows.push(t('T50', 2_000, { id: 'quiet' }));
    const newest800 = rows
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 800);
    expect(
      pickLatestPerTable(newest800, since).has(
        tableSessionKey('Sallon', 'T50'),
      ),
    ).toBe(false);
    expect(
      pickLatestPerTable(rows, since).get(tableSessionKey('Sallon', 'T50')),
    ).toMatchObject({ id: 'quiet' });
  });
});

describe('getFloorSnapshot cache', () => {
  beforeEach(() => {
    resetFloorSnapshotCacheForTests();
    vi.mocked(listOccupiedTables).mockReset();
    vi.mocked(listOccupiedTables).mockResolvedValue([]);
  });

  it('reuses a fresh snapshot until invalidate', async () => {
    await getFloorSnapshot();
    await getFloorSnapshot();
    expect(listOccupiedTables).toHaveBeenCalledTimes(1);
    invalidateFloorSnapshotCache();
    await getFloorSnapshot();
    expect(listOccupiedTables).toHaveBeenCalledTimes(2);
  });

  it('does not let a new caller join a load that started before invalidate', async () => {
    const resolvers: Array<(value: OccupiedTable[]) => void> = [];
    vi.mocked(listOccupiedTables).mockImplementation(
      () =>
        new Promise<OccupiedTable[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const first = getFloorSnapshot();
    await Promise.resolve();
    expect(resolvers).toHaveLength(1);
    invalidateFloorSnapshotCache();
    const second = getFloorSnapshot();
    await Promise.resolve();
    expect(resolvers.length).toBeGreaterThanOrEqual(2);
    vi.mocked(listOccupiedTables).mockResolvedValue([]);
    for (const resolve of resolvers) resolve([]);
    await Promise.all([first, second]);
  });
});
