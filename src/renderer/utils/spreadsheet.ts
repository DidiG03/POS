/**
 * Read and write the spreadsheets Admin imports the menu from.
 *
 * `.xlsx` is read with `read-excel-file`, `.csv` with `papaparse`; the
 * template is written with `write-excel-file`. They replace the `xlsx`
 * package, whose npm release is no longer updated. The old binary `.xls`
 * format is not read: such a file is refused with a message that says to
 * save it as `.xlsx`.
 *
 * The libraries are imported when first needed, so they stay out of the
 * waiter and till bundles.
 */

export type SpreadsheetSheet = { name: string; rows: unknown[][] };

export type SpreadsheetKind = 'xlsx' | 'xls' | 'text';

export const LEGACY_XLS_MESSAGE =
  'Old Excel files (.xls) cannot be read. Open the file in Excel, choose Save As, pick Excel Workbook (.xlsx) and import that file.';

/** What the first bytes say the file is, whatever its name. */
export function sniffSpreadsheetKind(data: ArrayBuffer): SpreadsheetKind {
  const b = new Uint8Array(data, 0, Math.min(8, data.byteLength));
  // ZIP container: .xlsx
  if (b[0] === 0x50 && b[1] === 0x4b) return 'xlsx';
  // OLE2 compound file: .xls from Excel 97-2003
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    return 'xls';
  }
  return 'text';
}

/** CSV text from bytes: UTF-8 (with or without BOM) or UTF-16 with a BOM. */
export function decodeCsvBytes(data: ArrayBuffer): string {
  const b = new Uint8Array(data);
  if (b[0] === 0xff && b[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(b.subarray(2));
  }
  if (b[0] === 0xfe && b[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(b.subarray(2));
  }
  // TextDecoder drops a UTF-8 BOM itself.
  return new TextDecoder('utf-8').decode(b);
}

function isBlankRow(row: unknown[]): boolean {
  return row.every(
    (cell) => cell === null || cell === undefined || cell === '',
  );
}

function withoutBlankRows(rows: unknown[][]): unknown[][] {
  return rows.filter((row) => Array.isArray(row) && !isBlankRow(row));
}

/**
 * Every sheet of the file as rows of cells, blank rows left out. Numbers
 * stay numbers in `.xlsx`; every `.csv` cell is text (so a barcode keeps
 * its leading zeros), with empty cells as `null`.
 */
export async function readSpreadsheet(
  data: ArrayBuffer,
): Promise<SpreadsheetSheet[]> {
  const kind = sniffSpreadsheetKind(data);
  if (kind === 'xls') throw new Error(LEGACY_XLS_MESSAGE);
  if (kind === 'xlsx') {
    const { default: readXlsxFile } = await import('read-excel-file/universal');
    const sheets = await readXlsxFile(data);
    return sheets.map((s) => ({
      name: String(s.sheet || ''),
      rows: withoutBlankRows(s.data as unknown[][]),
    }));
  }
  const { default: Papa } = await import('papaparse');
  const parsed = Papa.parse<string[]>(decodeCsvBytes(data), {
    skipEmptyLines: 'greedy',
  });
  const rows = (parsed.data || []).map((row) =>
    (Array.isArray(row) ? row : []).map((cell) =>
      cell === '' || cell === undefined ? null : cell,
    ),
  );
  return [{ name: 'Sheet1', rows: withoutBlankRows(rows) }];
}

/** An `.xlsx` file with one sheet holding `rows`. */
export async function writeSpreadsheet(
  rows: Array<Array<string | number | null>>,
  sheetName: string,
): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/universal');
  const data = rows.map((row) =>
    row.map((value) =>
      value === null || value === ''
        ? null
        : typeof value === 'number'
          ? { value, type: Number }
          : { value: String(value), type: String },
    ),
  );
  return writeXlsxFile(data, { sheet: sheetName }).toBlob();
}

/** Hand a file to the browser's download. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
