import { describe, expect, it } from 'vitest';
import {
  alreadyReminded,
  overdueTableMessage,
  overdueTables,
  overdueTablesConfig,
  overdueTablesProblem,
  pruneReminded,
  unpaidAmount,
} from './overdueTables';

describe('overdueTablesConfig', () => {
  it('reminds after 12 hours unless the venue says otherwise', () => {
    expect(overdueTablesConfig({})).toEqual({ hours: 12, action: 'remind' });
    expect(
      overdueTablesConfig({
        preferences: { overdueTables: { hours: 24, action: 'void' } },
      }),
    ).toEqual({ hours: 24, action: 'void' });
    expect(
      overdueTablesConfig({ preferences: { overdueTables: { hours: 500 } } }),
    ).toEqual({ hours: 12, action: 'remind' });
  });

  it('refuses a bad setting', () => {
    expect(overdueTablesProblem(undefined)).toBeNull();
    expect(overdueTablesProblem({ hours: 6, action: 'remind' })).toBeNull();
    expect(overdueTablesProblem({ hours: 0 })).toMatch(/between 1 and 72/);
    expect(overdueTablesProblem({ action: 'delete' })).toMatch(/remind/);
  });
});

describe('overdueTables', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  it('picks tables open longer than the limit', () => {
    const rows = [
      { area: 'A', label: '1', openedAt: new Date(now - 13 * 3600_000) },
      { area: 'A', label: '2', openedAt: new Date(now - 11 * 3600_000) },
    ];
    expect(overdueTables(rows, 12, now).map((t) => t.label)).toEqual(['1']);
    expect(overdueTables(rows, 6, now)).toHaveLength(2);
  });
});

describe('reminders', () => {
  const t = {
    area: 'A',
    label: '1',
    openedAt: new Date('2026-11-13T00:00:00Z'),
  };
  it('remembers a sitting, not a table', () => {
    const map = { 'A:1': t.openedAt.toISOString() };
    expect(alreadyReminded(map, t)).toBe(true);
    expect(
      alreadyReminded(map, {
        ...t,
        openedAt: new Date('2026-11-14T00:00:00Z'),
      }),
    ).toBe(false);
    expect(pruneReminded({ ...map, 'A:9': 'x' }, [t])).toEqual(map);
  });

  it('says what is unpaid', () => {
    expect(
      unpaidAmount([
        { qty: 2, unitPrice: 1.5 },
        { qty: 1, unitPrice: 9, voided: true },
        { qty: 1, unitPrice: 4, paid: true },
      ]),
    ).toBe(3);
    const msg = overdueTableMessage({
      area: 'A',
      label: '1',
      hours: 12,
      amount: 3,
      currency: 'EUR',
    });
    expect(msg).toContain('more than 12 hours');
    expect(msg).toContain('3.00 EUR unpaid');
    expect(msg).toContain('will not be closed automatically');
  });
});
