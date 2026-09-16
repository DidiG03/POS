import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));

import {
  COVERS_KEEP_PER_TABLE,
  compactCoversForTable,
  compactOversizedCovers,
} from './coversCompact';

describe('compactCoversForTable', () => {
  it('keeps the newest writes for a table', async () => {
    const deleted: unknown[] = [];
    const client = {
      covers: {
        findMany: async () => [{ id: 9 }, { id: 8 }, { id: 7 }],
        deleteMany: async (args: unknown) => {
          deleted.push(args);
          return { count: 4 };
        },
      },
    };
    await expect(compactCoversForTable('Salla', 'T7', client)).resolves.toBe(4);
    expect(COVERS_KEEP_PER_TABLE).toBe(3);
    expect(deleted[0]).toMatchObject({
      where: { area: 'Salla', label: 'T7', id: { notIn: [9, 8, 7] } },
    });
  });

  it('skips tables still under the keep cap', async () => {
    const client = {
      covers: {
        findMany: async () => [{ id: 2 }, { id: 1 }],
        deleteMany: async () => {
          throw new Error('should not delete');
        },
      },
    };
    await expect(compactCoversForTable('A', '1', client)).resolves.toBe(0);
  });
});

describe('compactOversizedCovers', () => {
  it('compacts only tables over the keep cap', async () => {
    const compacted: string[] = [];
    const client = {
      covers: {
        findMany: async (args: any) => {
          compacted.push(`${args.where.area}:${args.where.label}`);
          return [{ id: 3 }, { id: 2 }, { id: 1 }];
        },
        deleteMany: async () => ({ count: 2 }),
        groupBy: async () => [
          { area: 'A', label: '1', _count: { id: 8 } },
          { area: 'A', label: '2', _count: { id: 2 } },
        ],
      },
    };
    await expect(compactOversizedCovers(client)).resolves.toBe(2);
    expect(compacted).toEqual(['A:1']);
  });
});
