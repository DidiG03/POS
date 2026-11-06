import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, any>());
vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: async ({ where }: any) => {
        // Yield so two saves overlap unless the area lock serializes them.
        await new Promise((r) => setTimeout(r, 5));
        const v = store.get(where.key);
        return v ? { key: where.key, valueJson: v } : null;
      },
      upsert: async ({ where, create, update }: any) => {
        store.set(
          where.key,
          store.has(where.key) ? update.valueJson : create.valueJson,
        );
        return {};
      },
    },
  },
}));
vi.mock('./realtime', () => ({ broadcastTableMergesChanged: () => undefined }));

import { readTableMerges, writeTableMerges } from './tableMerges';

const g = (labels: string[]) => ({ id: labels.join('+'), labels, x: 0, y: 0 });

describe('writeTableMerges', () => {
  it('two hosts merging at once keep both merges', async () => {
    await Promise.all([
      writeTableMerges('Salla', [g(['T1', 'T2'])], []),
      writeTableMerges('Salla', [g(['T5', 'T6'])], []),
    ]);
    const labels = (await readTableMerges('Salla'))
      .map((x) => x.labels.join('+'))
      .sort();
    expect(labels).toEqual(['T1+T2', 'T5+T6']);
  });

  it('an app without base still replaces the list', async () => {
    await writeTableMerges('Veranda', [g(['T1', 'T2'])]);
    await writeTableMerges('Veranda', [g(['T3', 'T4'])]);
    expect((await readTableMerges('Veranda')).map((x) => x.id)).toEqual([
      'T3+T4',
    ]);
  });
});
