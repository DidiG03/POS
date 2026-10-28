import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  open: false,
  areas: [{ name: 'Main', count: 4 }] as Array<{ name: string; count: number }>,
  layouts: new Map<string, any[]>(),
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: vi.fn(async ({ where }: any) => {
        const area = String(where.key).replace('layout:global:', '');
        const nodes = h.layouts.get(area);
        return nodes ? { valueJson: { nodes } } : null;
      }),
    },
  },
}));
vi.mock('./core', () => ({
  coreServices: {
    isTableOpen: vi.fn(async () => h.open),
    readSettings: vi.fn(async () => ({})),
  },
}));
vi.mock('./tableAreasSync', () => ({
  tableAreasFromDb: vi.fn(async () => h.areas),
}));

import { checkFloorTable, tableInFloor } from './floorTables';

describe('tableInFloor', () => {
  it('uses the saved layout when there is one', () => {
    expect(
      tableInFloor({ label: 'G5', layoutLabels: ['G5'], defaultCount: 4 }),
    ).toBe(true);
    expect(
      tableInFloor({ label: 'T1', layoutLabels: ['G5'], defaultCount: 4 }),
    ).toBe(false);
  });
  it('falls back to T1..Tn without one', () => {
    expect(
      tableInFloor({ label: 'T4', layoutLabels: null, defaultCount: 4 }),
    ).toBe(true);
    expect(
      tableInFloor({ label: 'T5', layoutLabels: null, defaultCount: 4 }),
    ).toBe(false);
    expect(
      tableInFloor({ label: 'S1', layoutLabels: null, defaultCount: 4 }),
    ).toBe(false);
  });
});

describe('checkFloorTable', () => {
  beforeEach(() => {
    h.open = false;
    h.areas = [{ name: 'Main', count: 4 }];
    h.layouts = new Map([['Main', [{ kind: 'TABLE', label: 'T2' }]]]);
  });

  it('refuses an area that does not exist', async () => {
    expect(await checkFloorTable('Nowhere', 'X1')).toMatchObject({
      ok: false,
      code: 'UNKNOWN_AREA',
    });
  });

  it('refuses a table that is not on the layout', async () => {
    expect(await checkFloorTable('Main', 'S1')).toMatchObject({
      ok: false,
      code: 'UNKNOWN_TABLE',
    });
    expect(await checkFloorTable('Main', 'T2')).toEqual({ ok: true });
  });

  it('never strands an open bill on a table removed from the layout', async () => {
    h.open = true;
    expect(await checkFloorTable('Main', 'S1')).toEqual({ ok: true });
  });

  it('lets the shop counter through', async () => {
    expect(await checkFloorTable('Store', 'Counter')).toEqual({ ok: true });
  });
});
