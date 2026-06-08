/**
 * Parse a spreadsheet (.xlsx / .xls / .csv) of menu items into structured
 * rows the admin can review before importing. Designed to be forgiving:
 *
 *  - Reads EVERY sheet. A sheet without a "category" column falls back to
 *    using the SHEET NAME as the category (so "one tab per category" files
 *    work out of the box).
 *  - Detects the header row even when there are title/blank rows above it.
 *  - Understands English + Albanian column names.
 *  - Parses EU ("1.200,50") and US ("1,200.50") number formats and strips
 *    currency symbols.
 *
 * The heavy `xlsx` dependency is imported lazily by the caller so it only
 * loads when the admin actually opens the importer.
 */

export type ParsedMenuRow = {
  category: string;
  name: string;
  price: number;
  vatRate?: number;
  isKg?: boolean;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  sku?: string;
};

export type MenuParseResult = {
  rows: ParsedMenuRow[];
  warnings: string[];
};

type ColumnMap = {
  name?: number;
  price?: number;
  category?: number;
  vat?: number;
  kg?: number;
  station?: number;
  sku?: number;
};

const HEADER_SYNONYMS: Record<keyof ColumnMap, string[]> = {
  name: [
    'name',
    'item',
    'item name',
    'product',
    'dish',
    'title',
    'emri',
    'emer',
    'emër',
    'artikulli',
    'artikull',
    'produkti',
    'produkt',
    'pershkrimi',
    'përshkrimi',
    'description',
  ],
  price: [
    'price',
    'unit price',
    'amount',
    'cost',
    'cmimi',
    'çmimi',
    'cmim',
    'çmim',
    'vlera',
    'vlere',
    'vlerë',
  ],
  category: [
    'category',
    'categories',
    'group',
    'section',
    'menu',
    'type',
    'kategoria',
    'kategori',
    'grupi',
    'grup',
    'seksioni',
    'seksion',
    'lloji',
  ],
  vat: ['vat', 'vat rate', 'vatrate', 'vat%', 'tax', 'tvsh', 'tvsh%', 'tvsh '],
  kg: [
    'kg',
    'per kg',
    'perkg',
    'iskg',
    'by weight',
    'weight',
    'kile',
    'pesha',
    'peshë',
    'peshe',
    'me peshe',
    'me peshë',
  ],
  station: [
    'station',
    'kds',
    'kds station',
    'destination',
    'stacioni',
    'stacion',
  ],
  sku: ['sku', 'code', 'barcode', 'kodi', 'kod'],
};

function norm(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase();
}

function matchColumn(header: string): keyof ColumnMap | null {
  const h = norm(header);
  if (!h) return null;
  for (const key of Object.keys(HEADER_SYNONYMS) as (keyof ColumnMap)[]) {
    const list = HEADER_SYNONYMS[key];
    if (list.some((syn) => h === syn || h.includes(syn))) return key;
  }
  return null;
}

/** Find the header row (within the first rows) and map known columns. */
function detectHeader(
  aoa: unknown[][],
): { headerRow: number; cols: ColumnMap } | null {
  const limit = Math.min(aoa.length, 12);
  for (let r = 0; r < limit; r++) {
    const row = aoa[r] || [];
    const cols: ColumnMap = {};
    for (let c = 0; c < row.length; c++) {
      const key = matchColumn(String(row[c] ?? ''));
      if (key && cols[key] == null) cols[key] = c;
    }
    // A usable header needs at least a name + price column.
    if (cols.name != null && cols.price != null) {
      return { headerRow: r, cols };
    }
  }
  return null;
}

/** Parse a price/number cell tolerant of currency symbols + EU/US formats. */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let s = String(value ?? '').trim();
  if (!s) return null;
  // Strip everything except digits, separators and a leading minus.
  s = s.replace(/[^0-9.,-]/g, '');
  if (!s || s === '-' || s === '.' || s === ',') return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // The separator that appears LAST is the decimal separator.
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    s = s.split(thousands).join('');
    s = s.replace(decimal, '.');
  } else if (hasComma) {
    // Only commas: 3 trailing digits ⇒ thousands group (1,200 → 1200),
    // otherwise treat the comma as the decimal point (12,50 → 12.5).
    const after = s.slice(s.lastIndexOf(',') + 1);
    s = after.length === 3 ? s.split(',').join('') : s.replace(',', '.');
  } else if (hasDot) {
    const after = s.slice(s.lastIndexOf('.') + 1);
    // 1.200 ⇒ thousands group, 12.50 ⇒ decimal.
    if (
      after.length === 3 &&
      s.split('.').length === 2 &&
      !s.startsWith('0.')
    ) {
      s = s.split('.').join('');
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a VAT cell into a 0..1 rate. "20", "20%", "0.2" all → 0.2. */
export function parseVatRate(value: unknown): number | undefined {
  if (value == null || String(value).trim() === '') return undefined;
  const n = parseMoney(value);
  if (n == null) return undefined;
  let rate = n;
  if (rate > 1) rate = rate / 100; // 20 → 0.2
  if (!Number.isFinite(rate) || rate < 0) return undefined;
  return Math.min(1, rate);
}

const TRUTHY = new Set([
  'yes',
  'y',
  'true',
  '1',
  'kg',
  'x',
  'po',
  'true',
  'peshë',
  'peshe',
]);

function parseIsKg(value: unknown): boolean {
  return TRUTHY.has(norm(value));
}

function parseStation(
  value: unknown,
): 'KITCHEN' | 'BAR' | 'DESSERT' | undefined {
  const v = norm(value);
  if (!v) return undefined;
  if (v.includes('bar') || v.includes('pije')) return 'BAR';
  if (
    v.includes('dessert') ||
    v.includes('ëmbëls') ||
    v.includes('embels') ||
    v.includes('amel')
  )
    return 'DESSERT';
  if (
    v.includes('kitchen') ||
    v.includes('kuzhin') ||
    v.includes('food') ||
    v.includes('ushqim')
  )
    return 'KITCHEN';
  return undefined;
}

function cleanName(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function rowsFromSheet(
  sheetName: string,
  aoa: unknown[][],
  warnings: string[],
): ParsedMenuRow[] {
  const nonEmpty = aoa.filter((r) => (r || []).some((c) => norm(c) !== ''));
  if (!nonEmpty.length) return [];

  const detected = detectHeader(aoa);
  const out: ParsedMenuRow[] = [];
  const fallbackCategory = cleanName(sheetName) || 'Imported';

  if (detected) {
    const { headerRow, cols } = detected;
    // Categories are often written ONCE on a "section header" row (e.g. a
    // green bar reading "Sallata") with the item rows beneath it leaving the
    // category cell blank. We forward-fill the most recent category so those
    // items inherit it instead of all collapsing onto the sheet name.
    let currentCategory = '';
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const rawCat = cols.category != null ? cleanName(row[cols.category]) : '';
      const name = cleanName(row[cols.name!]);
      const price = parseMoney(row[cols.price!]);

      // A value in the category column carries forward to later rows.
      if (rawCat) currentCategory = rawCat;

      if (price == null) {
        // A label in the NAME column with no price (and no category column)
        // is a section header that defines the running category.
        if (name && cols.category == null) {
          currentCategory = name;
        } else if (name && !rawCat) {
          warnings.push(`${sheetName}: skipped "${name}" — no readable price.`);
        }
        continue;
      }
      if (!name) continue;

      out.push({
        category: rawCat || currentCategory || fallbackCategory,
        name,
        price: Math.max(0, price),
        vatRate: cols.vat != null ? parseVatRate(row[cols.vat]) : undefined,
        isKg: cols.kg != null ? parseIsKg(row[cols.kg]) : undefined,
        station:
          cols.station != null ? parseStation(row[cols.station]) : undefined,
        sku:
          cols.sku != null ? cleanName(row[cols.sku]) || undefined : undefined,
      });
    }
    return out;
  }

  // No header detected → positional fallback: first column is the name, the
  // first column that parses as a number is the price. Rows that have a label
  // but no number anywhere are treated as section headers (the category).
  warnings.push(
    `${sheetName}: no "Name"/"Price" header found — guessed columns (col 1 = name, first numeric column = price). Please verify the preview.`,
  );
  let currentCategory = '';
  for (const row of nonEmpty) {
    const name = cleanName(row[0]);
    if (!name) continue;
    // Skip a likely header row ("name"/"emri" in the first cell).
    if (matchColumn(name) === 'name') continue;
    let price: number | null = null;
    for (let c = 1; c < row.length; c++) {
      const p = parseMoney(row[c]);
      if (p != null) {
        price = p;
        break;
      }
    }
    if (price == null) {
      // Label with no price → section header.
      currentCategory = name;
      continue;
    }
    out.push({
      category: currentCategory || fallbackCategory,
      name,
      price: Math.max(0, price),
    });
  }
  return out;
}

/**
 * Parse a workbook ArrayBuffer into menu rows. `xlsx` is passed in by the
 * caller (lazy-loaded) to keep this module dependency-free and testable.
 */
export function parseMenuWorkbook(
  XLSX: typeof import('xlsx'),
  data: ArrayBuffer,
): MenuParseResult {
  const warnings: string[] = [];
  const wb = XLSX.read(data, { type: 'array' });
  const rows: ParsedMenuRow[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      blankrows: false,
      defval: null,
    });
    rows.push(...rowsFromSheet(sheetName, aoa, warnings));
  }

  // De-duplicate identical (category + name) rows within the file; keep the
  // last occurrence so a corrected line further down wins.
  const seen = new Map<string, number>();
  const deduped: ParsedMenuRow[] = [];
  for (const row of rows) {
    const key = `${norm(row.category)}||${norm(row.name)}`;
    if (seen.has(key)) {
      deduped[seen.get(key)!] = row;
    } else {
      seen.set(key, deduped.length);
      deduped.push(row);
    }
  }

  if (!deduped.length && !warnings.length) {
    warnings.push('No menu rows were found in the file.');
  }
  return { rows: deduped, warnings };
}
