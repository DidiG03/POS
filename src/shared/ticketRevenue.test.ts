import { describe, expect, it } from 'vitest';
import {
  effectiveVatRate,
  latestRowPerSession,
  splitGrossVat,
  sumTicketLinesNetVat,
} from './ticketRevenue';

const line = (name: string, unitPrice: number, extra: object = {}) => ({
  name,
  qty: 1,
  unitPrice,
  ...extra,
});

describe('latestRowPerSession', () => {
  it('keeps only the newest snapshot of a keyed session', () => {
    const rows = [
      {
        sessionKey: 'A:1@t0',
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(1_000),
        itemsJson: [line('Pizza', 10)],
      },
      {
        sessionKey: 'A:1@t0',
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(2_000),
        itemsJson: [line('Pizza', 10), line('Coke', 3)],
      },
    ];
    const kept = latestRowPerSession(rows);
    expect(kept).toHaveLength(1);
    expect(kept[0].itemsJson).toHaveLength(2);
  });

  it('counts a re-seated table as a separate session', () => {
    const rows = [
      {
        sessionKey: 'A:1@lunch',
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(1_000),
        itemsJson: [line('Pizza', 10)],
      },
      {
        sessionKey: 'A:1@dinner',
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(9_000),
        itemsJson: [line('Steak', 20)],
      },
    ];
    expect(latestRowPerSession(rows)).toHaveLength(2);
  });

  it('collapses legacy unkeyed snapshots that extend the previous one', () => {
    const rows = [
      {
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(1_000),
        itemsJson: [line('Pizza', 10)],
      },
      {
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(2_000),
        itemsJson: [line('Pizza', 10), line('Coke', 3)],
      },
      {
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(3_000),
        // Same lines, one of them voided later in the session.
        itemsJson: [line('Pizza', 10, { voided: true }), line('Coke', 3)],
      },
    ];
    const kept = latestRowPerSession(rows);
    expect(kept).toHaveLength(1);
    expect((kept[0].itemsJson as any[])[0].voided).toBe(true);
  });

  it('starts a new legacy session when the snapshot does not extend the last', () => {
    const rows = [
      {
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(1_000),
        itemsJson: [line('Pizza', 10), line('Coke', 3)],
      },
      {
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(5_000),
        itemsJson: [line('Steak', 20)],
      },
    ];
    expect(latestRowPerSession(rows)).toHaveLength(2);
  });

  it('never merges snapshots from different tables', () => {
    const rows = [
      {
        area: 'A',
        tableLabel: '1',
        createdAt: new Date(1_000),
        itemsJson: [line('Pizza', 10)],
      },
      {
        area: 'A',
        tableLabel: '2',
        createdAt: new Date(2_000),
        itemsJson: [line('Pizza', 10), line('Coke', 3)],
      },
    ];
    expect(latestRowPerSession(rows)).toHaveLength(2);
  });

  it('tolerates unordered input and rows with no timestamp', () => {
    const rows = [
      {
        sessionKey: 'A:1@t0',
        itemsJson: [line('Pizza', 10), line('Coke', 3)],
        createdAt: new Date(2_000),
      },
      { sessionKey: 'A:1@t0', itemsJson: [line('Pizza', 10)] },
    ];
    const kept = latestRowPerSession(rows);
    expect(kept).toHaveLength(1);
    expect(kept[0].itemsJson).toHaveLength(2);
  });

  it('returns an empty list for empty or invalid input', () => {
    expect(latestRowPerSession([])).toEqual([]);
    expect(latestRowPerSession(null as any)).toEqual([]);
  });

  it('collapses the revenue of a table fired three times to its final total', () => {
    const snapshot = (names: [string, number][]) =>
      names.map(([n, p]) => line(n, p));
    const rows = [
      {
        sessionKey: 'A:1@t0',
        createdAt: new Date(1_000),
        itemsJson: snapshot([['Pizza', 10]]),
      },
      {
        sessionKey: 'A:1@t0',
        createdAt: new Date(2_000),
        itemsJson: snapshot([
          ['Pizza', 10],
          ['Coke', 3],
        ]),
      },
      {
        sessionKey: 'A:1@t0',
        createdAt: new Date(3_000),
        itemsJson: snapshot([
          ['Pizza', 10],
          ['Coke', 3],
          ['Coffee', 2],
        ]),
      },
    ];
    const total = latestRowPerSession(rows).reduce(
      (sum, r) => sum + sumTicketLinesNetVat(r.itemsJson, false).net,
      0,
    );
    expect(total).toBe(15);
  });
});

describe('effectiveVatRate', () => {
  it('uses the line rate when it is a positive number', () => {
    expect(effectiveVatRate(0.2, 0.06)).toBe(0.2);
  });

  it('falls back to the default when the line rate is missing or zero', () => {
    expect(effectiveVatRate(0, 0.2)).toBe(0.2);
    expect(effectiveVatRate(undefined, 0.2)).toBe(0.2);
    expect(effectiveVatRate(null, 0.2)).toBe(0.2);
  });

  it('returns 0 when neither the line nor the default has a positive rate', () => {
    expect(effectiveVatRate(0, 0)).toBe(0);
    expect(effectiveVatRate(undefined, undefined)).toBe(0);
  });
});

describe('splitGrossVat (VAT-inclusive)', () => {
  it('extracts the contained VAT from a gross amount', () => {
    const { net, vat } = splitGrossVat(120, 0.2);
    expect(net).toBeCloseTo(100, 6);
    expect(vat).toBeCloseTo(20, 6);
  });

  it('treats a 0 rate as VAT-free (net === gross)', () => {
    expect(splitGrossVat(100, 0)).toEqual({ net: 100, vat: 0 });
  });
});

describe('sumTicketLinesNetVat', () => {
  it('excludes voided lines and extracts VAT inclusively', () => {
    const { net, vat } = sumTicketLinesNetVat([
      { name: 'A', qty: 2, unitPrice: 10, vatRate: 0.1 },
      { name: 'B', qty: 1, unitPrice: 5, vatRate: 0, voided: true },
    ]);
    // gross live = 20 @ 10% inclusive
    expect(net).toBeCloseTo(20 / 1.1, 6);
    expect(vat).toBeCloseTo(20 - 20 / 1.1, 6);
  });

  it('returns zeros for empty or invalid itemsJson', () => {
    expect(sumTicketLinesNetVat(null)).toEqual({ net: 0, vat: 0 });
    expect(sumTicketLinesNetVat([])).toEqual({ net: 0, vat: 0 });
  });

  it('skips VAT when vatEnabled is false (net === gross)', () => {
    const { net, vat } = sumTicketLinesNetVat(
      [{ name: 'A', qty: 1, unitPrice: 100, vatRate: 0.2 }],
      false,
    );
    expect(net).toBe(100);
    expect(vat).toBe(0);
  });

  it('falls back to the default rate for lines with a 0/missing rate', () => {
    const { net, vat } = sumTicketLinesNetVat(
      [{ name: 'A', qty: 1, unitPrice: 120, vatRate: 0 }],
      true,
      0.2,
    );
    expect(net).toBeCloseTo(100, 6);
    expect(vat).toBeCloseTo(20, 6);
  });
});
