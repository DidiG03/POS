import { describe, expect, it } from 'vitest';
import {
  asPositiveId,
  latestCoverIdSelectSql,
  latestIdWhereSql,
  latestTicketIdSelectSql,
  mergeLatestIdRows,
  parseLatestIdRows,
} from './ticketLogLatest';

describe('latestIdWhereSql', () => {
  it('groups labels per area so a quiet table is still addressed', () => {
    const clauses = latestIdWhereSql(
      [
        { area: 'Salla', label: 'T1' },
        { area: 'Salla', label: 'T50' },
        { area: 'Bar', label: 'B1' },
      ],
      'tableLabel',
    );
    expect(clauses).toHaveLength(2);
    expect(clauses[0]?.sql).toContain('tableLabel IN');
    expect(clauses[0]?.params).toEqual(['Salla', 'T1', 'T50']);
    expect(clauses[1]?.params).toEqual(['Bar', 'B1']);
  });

  it('chunks large floors under SQLite variable limits', () => {
    const pairs = Array.from({ length: 450 }, (_, i) => ({
      area: 'Salla',
      label: `T${i + 1}`,
    }));
    const clauses = latestIdWhereSql(pairs, 'tableLabel', 400);
    expect(clauses).toHaveLength(2);
    expect(clauses[0]?.params).toHaveLength(401);
    expect(clauses[1]?.params).toHaveLength(51);
  });
});

describe('latest id select', () => {
  it('asks SQLite for MAX(id) per table, not a global LIMIT', () => {
    const where = latestIdWhereSql(
      [{ area: 'Salla', label: 'T7' }],
      'tableLabel',
    )[0]!;
    expect(latestTicketIdSelectSql(where).sql).toMatch(
      /MAX\(id\).*GROUP BY area, tableLabel/s,
    );
    const coversWhere = latestIdWhereSql(
      [{ area: 'Salla', label: 'T7' }],
      'label',
    )[0]!;
    expect(latestCoverIdSelectSql(coversWhere).sql).toMatch(
      /MAX\(id\).*GROUP BY area, label/s,
    );
  });
});

describe('parseLatestIdRows', () => {
  it('coerces BigInt ids from SQLite', () => {
    expect(asPositiveId(8n)).toBe(8);
    expect(
      parseLatestIdRows([
        { area: 'Salla', tableLabel: 'T7', id: 12n },
        { area: 'Salla', label: 'T8', id: '13' },
      ]),
    ).toEqual([
      { area: 'Salla', tableLabel: 'T7', id: 12 },
      { area: 'Salla', tableLabel: 'T8', id: 13 },
    ]);
  });

  it('keeps the greater id when chunks overlap', () => {
    const merged = mergeLatestIdRows([
      [{ area: 'Salla', tableLabel: 'T1', id: 10 }],
      [{ area: 'Salla', tableLabel: 'T1', id: 14 }],
    ]);
    expect(merged).toEqual([{ area: 'Salla', tableLabel: 'T1', id: 14 }]);
  });
});
