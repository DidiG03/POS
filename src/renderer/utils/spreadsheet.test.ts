import { describe, expect, it } from 'vitest';
import { parseMenuWorkbook } from './menuImport';
import {
  LEGACY_XLS_MESSAGE,
  decodeCsvBytes,
  readSpreadsheet,
  sniffSpreadsheetKind,
  writeSpreadsheet,
} from './spreadsheet';

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('readSpreadsheet (.xlsx)', () => {
  it('reads back what the template writer wrote, numbers as numbers', async () => {
    const file = await writeSpreadsheet(
      [
        ['Category', 'Name', 'Price', 'VAT', 'Kg', 'Barcode'],
        ['Drinks', 'Coca-Cola 330ml', 100, 20, 'No', 5449000000996],
        ['Deli', 'Prosciutto (per kg)', 1800.5, 20, 'Yes', ''],
      ],
      'Menu',
    );
    const sheets = await readSpreadsheet(await file.arrayBuffer());
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe('Menu');
    expect(sheets[0]!.rows[1]).toEqual([
      'Drinks',
      'Coca-Cola 330ml',
      100,
      20,
      'No',
      5449000000996,
    ]);
    expect(sheets[0]!.rows[2]![2]).toBe(1800.5);
    expect(sheets[0]!.rows[2]![5] ?? null).toBeNull();
  });

  it('leaves out blank rows', async () => {
    const file = await writeSpreadsheet(
      [
        ['Name', 'Price'],
        [null, null],
        ['Espresso', 1.5],
      ],
      'Menu',
    );
    const sheets = await readSpreadsheet(await file.arrayBuffer());
    expect(sheets[0]!.rows).toEqual([
      ['Name', 'Price'],
      ['Espresso', 1.5],
    ]);
  });
});

describe('readSpreadsheet (.csv)', () => {
  it('reads commas, quotes and a UTF-8 BOM', async () => {
    const sheets = await readSpreadsheet(
      bytes('\uFEFFCategory,Name,Price\nFood,"Pizza, large",6.50\n\n'),
    );
    expect(sheets[0]!.rows).toEqual([
      ['Category', 'Name', 'Price'],
      ['Food', 'Pizza, large', '6.50'],
    ]);
  });

  it('reads the semicolon files Excel saves in Albania and Italy', async () => {
    const sheets = await readSpreadsheet(
      bytes('Kategoria;Emri;Çmimi\nPije;Kafe;1,50\nPije;Ujë;;\n'),
    );
    expect(sheets[0]!.rows[1]).toEqual(['Pije', 'Kafe', '1,50']);
    expect(sheets[0]!.rows[2]!.slice(0, 3)).toEqual(['Pije', 'Ujë', null]);
  });

  it('keeps the leading zeros of a barcode', async () => {
    const sheets = await readSpreadsheet(
      bytes('Category,Name,Price,Barcode\nDrinks,Cola,100,0123456789012\n'),
    );
    const { rows } = parseMenuWorkbook(sheets);
    expect(rows[0]!.sku).toBe('0123456789012');
    expect(rows[0]!.price).toBe(100);
  });

  it('reads UTF-16 with a BOM', () => {
    const text = 'Emri;Çmimi';
    const buf = new Uint8Array(2 + text.length * 2);
    buf[0] = 0xff;
    buf[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      buf[2 + i * 2] = code & 0xff;
      buf[3 + i * 2] = code >> 8;
    }
    expect(decodeCsvBytes(buf.buffer as ArrayBuffer)).toBe(text);
  });
});

describe('old .xls files', () => {
  it('are recognised by content and refused with what to do instead', async () => {
    const ole = new Uint8Array([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    expect(sniffSpreadsheetKind(ole.buffer as ArrayBuffer)).toBe('xls');
    await expect(readSpreadsheet(ole.buffer as ArrayBuffer)).rejects.toThrow(
      LEGACY_XLS_MESSAGE,
    );
  });

  it('does not mistake text or an empty file for one', () => {
    expect(sniffSpreadsheetKind(bytes('Name,Price'))).toBe('text');
    expect(sniffSpreadsheetKind(new ArrayBuffer(0))).toBe('text');
  });
});
