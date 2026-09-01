import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/client', () => ({ prisma: {} }));

import {
  pickLatestPerTable,
  tableSessionKey,
  ticketRunningTotal,
} from './floorSnapshot';

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
  const t = (
    label: string,
    ms: number,
    extra: Record<string, unknown> = {},
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
});
