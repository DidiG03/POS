import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));
vi.mock('./tableOccupancy', () => ({ getOpenedAt: vi.fn(async () => null) }));

import { pickLatestSessionTicket } from './tableSession';

describe('pickLatestSessionTicket', () => {
  const openAt = Date.parse('2026-09-21T14:00:00.000Z');

  it('returns the newest id in the current sitting', () => {
    const picked = pickLatestSessionTicket(
      [
        {
          id: 220,
          createdAt: '2026-09-21T14:10:00.000Z',
          items: [{ name: 'Byrek' }],
        },
        {
          id: 200,
          createdAt: '2026-09-21T14:05:00.000Z',
          items: [{ name: 'Coke' }],
        },
      ],
      openAt,
    );
    expect(picked?.id).toBe(220);
  });

  it('skips a previous sitting even when it has the newest createdAt text', () => {
    const picked = pickLatestSessionTicket(
      [
        {
          id: 50,
          createdAt: '2026-09-20T18:00:00.000Z',
        },
      ],
      openAt,
    );
    expect(picked).toBeNull();
  });

  /**
   * SQLite `ORDER BY createdAt DESC` with mixed ISO text and epoch ms puts
   * TEXT first. The old lookup took 40 of those and never reached the live
   * integer-timestamp send — covers still showed because they order by id.
   */
  it('keeps the live epoch-ms send when older ISO rows sort "newer"', () => {
    const isoOld = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      createdAt: '2026-09-20T18:00:00.000Z',
    }));
    const live = {
      id: 41,
      createdAt: openAt + 60_000,
      itemsJson: [{ name: 'Tave kosi', qty: 2 }],
    };
    const newestIdFirst = [live, ...isoOld.slice().reverse()];
    const picked = pickLatestSessionTicket(newestIdFirst, openAt);
    expect(picked).toEqual(live);
  });

  it('keeps the newest row when createdAt cannot be parsed', () => {
    const picked = pickLatestSessionTicket(
      [
        { id: 9, createdAt: {} },
        { id: 8, createdAt: '2026-09-20T10:00:00.000Z' },
      ],
      openAt,
    );
    expect(picked?.id).toBe(9);
  });

  it('returns the newest row when there is no session bound', () => {
    expect(
      pickLatestSessionTicket(
        [
          { id: 3, createdAt: 1 },
          { id: 2, createdAt: 2 },
        ],
        null,
      )?.id,
    ).toBe(3);
  });
});
