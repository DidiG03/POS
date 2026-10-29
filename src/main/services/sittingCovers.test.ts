import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  open: new Date('2026-10-29T10:00:00Z') as Date | null,
  coverRows: [] as any[],
  bill: null as any,
}));

vi.mock('@db/client', () => ({
  prisma: {
    covers: {
      findFirst: vi.fn(async () => h.coverRows[0] ?? null),
      findMany: vi.fn(async () => h.coverRows),
    },
  },
}));
vi.mock('./tableSession', () => ({
  getTableSessionStartedAt: vi.fn(async () => h.open),
  findLatestTicketLogForCurrentSession: vi.fn(async () => h.bill),
}));

import { currentSittingCovers } from './sittingCovers';

beforeEach(() => {
  h.open = new Date('2026-10-29T10:00:00Z');
  h.coverRows = [];
  h.bill = null;
});

describe('currentSittingCovers (QA round 4, #9)', () => {
  it('uses the covers dialog count when there is one', async () => {
    h.coverRows = [{ covers: 4, createdAt: new Date() }];
    h.bill = { covers: 2 };
    expect(await currentSittingCovers('Salla', 'Q30')).toBe(4);
  });

  it('falls back to the count stored on the bill (what reports show)', async () => {
    h.bill = { covers: 2 };
    expect(await currentSittingCovers('Salla', 'Q30')).toBe(2);
  });

  it('has none for a free table or a bill without a count', async () => {
    h.bill = { covers: null };
    expect(await currentSittingCovers('Salla', 'Q30')).toBeNull();
    h.open = null;
    h.bill = { covers: 2 };
    expect(await currentSittingCovers('Salla', 'Q30')).toBeNull();
  });
});
