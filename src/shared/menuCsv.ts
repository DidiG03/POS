/**
 * The setup wizard's menu CSV: a fixed template and a strict check that
 * reports every problem by row, so nothing is imported half-right.
 *
 * Template columns: category, name, price, vat_rate, station.
 *   - price: a number, 0 or more ("1.50", "1,50", "€1.50" all read 1.5);
 *   - vat_rate: a percentage (20, 6, 0) or a fraction (0.2); empty = the
 *     venue's default rate;
 *   - station: KITCHEN, BAR or DESSERT; empty = KITCHEN.
 * The Admin menu page keeps its forgiving importer for any spreadsheet.
 */

export const MENU_CSV_COLUMNS = [
  'category',
  'name',
  'price',
  'vat_rate',
  'station',
] as const;

export const MENU_CSV_TEMPLATE = [
  MENU_CSV_COLUMNS.join(','),
  'Drinks,Espresso,1.50,20,BAR',
  'Drinks,Still water 0.5l,1.00,20,BAR',
  'Food,Margherita pizza,7.50,20,KITCHEN',
  'Food,"Burger, fries",9.00,20,KITCHEN',
  'Desserts,Tiramisu,4.50,20,DESSERT',
  '',
].join('\n');

export type MenuStation = 'KITCHEN' | 'BAR' | 'DESSERT';

export interface MenuCsvRow {
  /** 1-based line in the file. */
  line: number;
  category: string;
  name: string;
  price: number;
  vatRate?: number;
  station: MenuStation;
}

export interface MenuCsvError {
  line: number;
  column?: string;
  message: string;
}

/** RFC 4180 CSV: quoted fields, "" for a quote, commas/newlines in quotes. */
export function parseCsv(text: string): string[][] {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',' || ch === ';') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readPrice(raw: string): number | null {
  const s = raw.replace(/[€£$\s]|lek|all/gi, '').trim();
  if (!s) return null;
  // "1,50" (comma decimal) or "1.50"; "1.200,50" or "1,200.50".
  let norm = s;
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s))
    norm = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) norm = s.replace(/,/g, '');
  else norm = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(norm)) return null;
  return Number(norm);
}

/** Allowed VAT rates in Albania and the UK, as fractions. */
const KNOWN_RATES = [0, 0.05, 0.06, 0.1, 0.2];

function readVat(raw: string): number | null | undefined {
  const s = raw.replace('%', '').replace(',', '.').trim();
  if (!s) return undefined;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  const frac = n > 1 ? n / 100 : n;
  return KNOWN_RATES.some((r) => Math.abs(r - frac) < 1e-9) ? frac : null;
}

/** Check a menu CSV. Rows are only returned when there are no errors. */
export function validateMenuCsv(text: string): {
  rows: MenuCsvRow[];
  errors: MenuCsvError[];
} {
  const table = parseCsv(text);
  const errors: MenuCsvError[] = [];
  const rows: MenuCsvRow[] = [];
  const headerIdx = table.findIndex((r) => r.some((c) => c.trim()));
  if (headerIdx < 0) {
    return { rows, errors: [{ line: 1, message: 'The file is empty.' }] };
  }
  const header = table[headerIdx].map((h) =>
    h.trim().toLowerCase().replace(/\s+/g, '_'),
  );
  const col = (name: string) => header.indexOf(name);
  for (const required of ['category', 'name', 'price']) {
    if (col(required) < 0) {
      errors.push({
        line: headerIdx + 1,
        column: required,
        message: `The header has no "${required}" column. Use the template: ${MENU_CSV_COLUMNS.join(', ')}.`,
      });
    }
  }
  if (errors.length) return { rows: [], errors };
  const seen = new Map<string, number>();
  for (let i = headerIdx + 1; i < table.length; i++) {
    const cells = table[i];
    const line = i + 1;
    if (!cells.some((c) => c.trim())) continue;
    const get = (name: string) => {
      const c = col(name);
      return c < 0 ? '' : String(cells[c] ?? '').trim();
    };
    const category = get('category');
    const name = get('name');
    const priceRaw = get('price');
    const vatRaw = get('vat_rate') || get('vat');
    const stationRaw = get('station').toUpperCase();
    let bad = false;
    const fail = (column: string, message: string) => {
      errors.push({ line, column, message });
      bad = true;
    };
    if (!category) fail('category', 'Category is empty.');
    if (!name) fail('name', 'Name is empty.');
    else if (name.length > 80)
      fail('name', 'Name is longer than 80 characters.');
    const price = readPrice(priceRaw);
    if (!priceRaw) fail('price', 'Price is empty.');
    else if (price == null) fail('price', `"${priceRaw}" is not a price.`);
    else if (price < 0) fail('price', 'Price cannot be negative.');
    else if (price > 1_000_000) fail('price', 'Price is too large.');
    const vat = readVat(vatRaw);
    if (vat === null) {
      fail(
        'vat_rate',
        `"${vatRaw}" is not a VAT rate (use 20, 10, 6, 5 or 0).`,
      );
    }
    const station: MenuStation | null = !stationRaw
      ? 'KITCHEN'
      : stationRaw === 'KITCHEN' ||
          stationRaw === 'BAR' ||
          stationRaw === 'DESSERT'
        ? stationRaw
        : null;
    if (!station)
      fail(
        'station',
        `"${get('station')}" is not a station (KITCHEN, BAR or DESSERT).`,
      );
    if (name && category) {
      const key = `${category.toLowerCase()}||${name.toLowerCase()}`;
      const first = seen.get(key);
      if (first)
        fail('name', `"${name}" in ${category} is already on line ${first}.`);
      else seen.set(key, line);
    }
    if (!bad) {
      rows.push({
        line,
        category,
        name,
        price: Math.round(price! * 100) / 100,
        ...(vat !== undefined ? { vatRate: vat as number } : {}),
        station: station!,
      });
    }
  }
  if (!rows.length && !errors.length) {
    errors.push({
      line: headerIdx + 2,
      message: 'The file has no menu rows under the header.',
    });
  }
  return { rows: errors.length ? [] : rows, errors };
}
