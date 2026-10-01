import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseBarcode,
  parseMenuWorkbook,
  parseMoney,
  parseVatRate,
  rowsFromSheet,
} from './menuImport';

describe('parseMoney', () => {
  it('passes through finite numbers', () => {
    expect(parseMoney(12.5)).toBe(12.5);
    expect(parseMoney(0)).toBe(0);
  });

  it('parses plain integers and decimals', () => {
    expect(parseMoney('350')).toBe(350);
    expect(parseMoney('12.50')).toBe(12.5);
  });

  it('strips currency symbols and spaces', () => {
    expect(parseMoney('€ 12.50')).toBe(12.5);
    expect(parseMoney('1 200')).toBe(1200);
    expect(parseMoney('350 Lek')).toBe(350);
  });

  it('handles EU format (comma decimal, dot thousands)', () => {
    expect(parseMoney('1.200,50')).toBeCloseTo(1200.5, 5);
    expect(parseMoney('12,50')).toBe(12.5);
  });

  it('handles US format (dot decimal, comma thousands)', () => {
    expect(parseMoney('1,200.50')).toBeCloseTo(1200.5, 5);
    expect(parseMoney('1,200')).toBe(1200);
  });

  it('treats a 3-digit dotted group as thousands', () => {
    expect(parseMoney('1.200')).toBe(1200);
    expect(parseMoney('12.500')).toBe(12500);
  });

  it('returns null for empty / non-numeric input', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
});

describe('parseVatRate', () => {
  it('converts whole-number percentages to a 0..1 rate', () => {
    expect(parseVatRate('20')).toBeCloseTo(0.2, 5);
    expect(parseVatRate('20%')).toBeCloseTo(0.2, 5);
  });

  it('keeps already-fractional rates', () => {
    expect(parseVatRate('0.2')).toBeCloseTo(0.2, 5);
    expect(parseVatRate(0.06)).toBeCloseTo(0.06, 5);
  });

  it('clamps and rejects invalid values', () => {
    expect(parseVatRate('150')).toBe(1);
    expect(parseVatRate('')).toBeUndefined();
    expect(parseVatRate('abc')).toBeUndefined();
  });
});

describe('rowsFromSheet — category parsing', () => {
  it('uses a repeated per-row category column (Albanian headers)', () => {
    const warnings: string[] = [];
    const aoa: unknown[][] = [
      ['Kategoria', 'Emri', 'Çmimi (Lekë)'],
      ['Sallata', 'Patate frture', 300],
      ['Sallata', 'Sallatë jeshile', 400],
      ['Antipasta', 'Burrata', 500],
    ];
    const rows = rowsFromSheet('Menu', aoa, warnings);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      category: 'Sallata',
      name: 'Patate frture',
      price: 300,
    });
    expect(rows[1].category).toBe('Sallata');
    expect(rows[2]).toMatchObject({
      category: 'Antipasta',
      name: 'Burrata',
      price: 500,
    });
  });

  it('forward-fills a section-header category with blank cells below', () => {
    const warnings: string[] = [];
    const aoa: unknown[][] = [
      ['Kategoria', 'Emri', 'Çmimi (Lekë)'],
      ['Sallata', null, null], // green section header row
      [null, 'Patate frture', 300],
      [null, 'Sallatë jeshile', 400],
      ['Antipasta', null, null], // next section header
      [null, 'Burrata', 500],
      [null, 'Tartar viçi', 1200],
    ];
    const rows = rowsFromSheet('Menu - Ullishtja', aoa, warnings);
    expect(rows.map((r) => r.category)).toEqual([
      'Sallata',
      'Sallata',
      'Antipasta',
      'Antipasta',
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      'Patate frture',
      'Sallatë jeshile',
      'Burrata',
      'Tartar viçi',
    ]);
  });

  it('treats name-column section headers as categories when there is no category column', () => {
    const warnings: string[] = [];
    const aoa: unknown[][] = [
      ['Name', 'Price'],
      ['STARTERS', null],
      ['Bruschetta', 4.5],
      ['MAINS', null],
      ['Pizza', 8],
    ];
    const rows = rowsFromSheet('Sheet1', aoa, warnings);
    expect(rows).toEqual([
      {
        category: 'STARTERS',
        name: 'Bruschetta',
        price: 4.5,
        vatRate: undefined,
        isKg: undefined,
        station: undefined,
        sku: undefined,
      },
      {
        category: 'MAINS',
        name: 'Pizza',
        price: 8,
        vatRate: undefined,
        isKg: undefined,
        station: undefined,
        sku: undefined,
      },
    ]);
  });
});

describe('barcodes (shop mode)', () => {
  it('keeps the exact number behind Excel\'s "8.7148E+12" display', () => {
    expect(parseBarcode(8714800003124)).toBe('8714800003124');
    expect(parseBarcode(80067955)).toBe('80067955');
    expect(parseBarcode(' 871-480 0003124 ')).toBe('8714800003124');
  });

  it('drops codes Excel already rounded, with a reason', () => {
    const problems: string[] = [];
    expect(parseBarcode('8.7148E+12', (p) => problems.push(p))).toBeUndefined();
    expect(parseBarcode(12.5, (p) => problems.push(p))).toBeUndefined();
    expect(problems).toHaveLength(2);
    expect(parseBarcode('')).toBeUndefined();
    expect(parseBarcode(null)).toBeUndefined();
  });

  it('reads the Kategoria / Emri / Çmimi / Barcode layout', () => {
    const warnings: string[] = [];
    const rows = rowsFromSheet(
      'Menu',
      [
        ['Kategoria', 'Emri', 'Çmimi (Lekë)', 'Barcode'],
        ['Birra'],
        ['Birra', 'Bavaria 33ml', 100, 8714800003216],
        ['Birra', 'Peroni', 150, 80067955],
        ['Birra', 'Draft', 200, null],
      ],
      warnings,
    );
    expect(rows.map((r) => [r.name, r.price, r.sku])).toEqual([
      ['Bavaria 33ml', 100, '8714800003216'],
      ['Peroni', 150, '80067955'],
      ['Draft', 200, undefined],
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps a shared barcode on the first product only', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Kategoria', 'Emri', 'Çmimi', 'Barcode'],
      ['Patatina', 'Doritos Nacho', 150, 8606017379393],
      ['Patatina', 'Doritos Nacho F1', 150, 8606017379393],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Menu');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const { rows, warnings } = parseMenuWorkbook(XLSX, buf);
    expect(rows.map((r) => r.sku)).toEqual(['8606017379393', undefined]);
    expect(warnings.join(' ')).toContain('8606017379393');
  });
});
