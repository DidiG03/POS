import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsert = vi.fn();
const updateMany = vi.fn();
const findMany = vi.fn();

vi.mock('@db/client', () => ({
  prisma: {
    area: {
      upsert: (...a: unknown[]) => upsert(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  },
}));

import { syncTableAreasToDb, tableAreasFromDb } from './tableAreasSync';

describe('syncTableAreasToDb', () => {
  beforeEach(() => {
    upsert.mockReset().mockResolvedValue({});
    updateMany.mockReset().mockResolvedValue({ count: 0 });
    findMany.mockReset();
  });

  it('upserts named areas and deactivates everything else', async () => {
    await syncTableAreasToDb([
      { name: ' Salla ', count: 10 },
      { name: '', count: 4 },
      { name: 'New Area', count: 8 },
    ]);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(1, {
      where: { name: 'Salla' },
      create: { name: 'Salla', defaultCount: 10, sortOrder: 0 },
      update: { defaultCount: 10, sortOrder: 0, active: true },
    });
    expect(upsert).toHaveBeenNthCalledWith(2, {
      where: { name: 'New Area' },
      create: { name: 'New Area', defaultCount: 8, sortOrder: 1 },
      update: { defaultCount: 8, sortOrder: 1, active: true },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { name: { notIn: ['Salla', 'New Area'] } },
      data: { active: false },
    });
  });

  it('deactivates every Area row when the list is empty', async () => {
    await syncTableAreasToDb([]);
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { name: { notIn: [] } },
      data: { active: false },
    });
  });
});

describe('tableAreasFromDb', () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it('prefers live Area rows over JSON settings', async () => {
    findMany.mockResolvedValue([
      { name: 'Salla', defaultCount: 12 },
      { name: 'Ballkoni', defaultCount: 6 },
    ]);
    await expect(
      tableAreasFromDb([{ name: 'Stale JSON', count: 99 }]),
    ).resolves.toEqual([
      { name: 'Salla', count: 12 },
      { name: 'Ballkoni', count: 6 },
    ]);
  });

  it('falls back to JSON when the Area table is empty', async () => {
    findMany.mockResolvedValue([]);
    await expect(
      tableAreasFromDb([{ name: ' Salla ', count: 10 }]),
    ).resolves.toEqual([{ name: 'Salla', count: 10 }]);
  });
});
