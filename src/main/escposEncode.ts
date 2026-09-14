/**
 * ESC/POS text encoding for thermal receipts.
 *
 * Cheap ESC/POS printers do not speak UTF-8. They print a single-byte code
 * page. We select IBM PC850 (`ESC t 2`) because it is the page almost every
 * clone ships with AND it contains the Albanian letters ë Ë ç Ç. Anything
 * else is folded to ASCII rather than being replaced with "?".
 */

/** IBM Code Page 850 — enough Latin letters for Albanian / neighbouring langs. */
const PC850: Record<string, number> = {
  Ç: 0x80,
  ü: 0x81,
  é: 0x82,
  â: 0x83,
  ä: 0x84,
  à: 0x85,
  å: 0x86,
  ç: 0x87,
  ê: 0x88,
  ë: 0x89,
  è: 0x8a,
  ï: 0x8b,
  î: 0x8c,
  ì: 0x8d,
  Ä: 0x8e,
  Å: 0x8f,
  É: 0x90,
  æ: 0x91,
  Æ: 0x92,
  ô: 0x93,
  ö: 0x94,
  ò: 0x95,
  û: 0x96,
  ù: 0x97,
  ÿ: 0x98,
  Ö: 0x99,
  Ü: 0x9a,
  á: 0xa0,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  ñ: 0xa4,
  Ñ: 0xa5,
  ã: 0xc6,
  Ã: 0xc7,
  Ê: 0xd2,
  Ë: 0xd3,
  È: 0xd4,
  Ó: 0xe0,
  ß: 0xe1,
  Ô: 0xe2,
  Ò: 0xe3,
  õ: 0xe4,
  Õ: 0xe5,
  Ú: 0xe9,
  Û: 0xea,
  Ù: 0xeb,
  ý: 0xec,
  Ý: 0xed,
  '´': 0xef,
};

export type ReceiptPaperMm = 58 | 80;

export type ReceiptLayout = {
  paperMm: ReceiptPaperMm;
  cols: number;
  priceCols: number;
  nameCols: number;
  sep: string;
  /** Double-width (GS ! 0x11) characters eat two columns. */
  doubleWidthCols: number;
  /** Font B (9×17) columns — denser than Font A, used on kitchen slips. */
  fontBCols: number;
};

export function receiptPaperMm(raw: unknown): ReceiptPaperMm {
  return Number(raw) === 58 ? 58 : 80;
}

export function receiptLayout(paperMm: ReceiptPaperMm): ReceiptLayout {
  const cols = paperMm === 58 ? 32 : 48;
  const priceCols = paperMm === 58 ? 10 : 12;
  return {
    paperMm,
    cols,
    priceCols,
    nameCols: cols - priceCols,
    sep: '-'.repeat(cols),
    doubleWidthCols: Math.floor(cols / 2),
    fontBCols: paperMm === 58 ? 42 : 64,
  };
}

/** Prefer the receipt printer's paper size; default 80mm (48 columns). */
export function layoutFromSettings(settings: any): ReceiptLayout {
  const printers = Array.isArray(settings?.printers) ? settings.printers : [];
  const receiptId = settings?.printerRouting?.receiptPrinterId;
  const fromList =
    (receiptId &&
      printers.find((p: any) => String(p?.id) === String(receiptId))) ||
    printers.find((p: any) => String(p?.id) === 'default') ||
    printers[0];
  const mm = receiptPaperMm(
    fromList?.paperWidthMm ?? settings?.printer?.paperWidthMm,
  );
  return receiptLayout(mm);
}

export function padRight(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + ' '.repeat(len - s.length);
}

export function padLeft(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return ' '.repeat(len - s.length) + s;
}

export function wrapEscposText(s: string, width: number): string[] {
  const t = String(s || '').trim();
  if (!t) return [];
  const w = Math.max(8, Math.min(80, Number(width) || 32));
  const out: string[] = [];
  let cur = t;
  while (cur.length > w) {
    const slice = cur.slice(0, w + 1);
    let cut = slice.lastIndexOf(' ');
    if (cut < Math.floor(w * 0.5)) cut = w;
    out.push(cur.slice(0, cut).trimEnd());
    cur = cur.slice(cut).trimStart();
  }
  if (cur) out.push(cur);
  return out;
}

/** Name on the left, price on the right, using the full paper width. */
export function formatTwoCol(
  left: string,
  right: string,
  layout: ReceiptLayout,
): string {
  const rightText = String(right || '');
  const rightW = Math.max(layout.priceCols, rightText.length);
  const leftW = Math.max(8, layout.cols - rightW);
  const wrapped = wrapEscposText(String(left || ''), leftW);
  const parts = wrapped.length ? wrapped : [''];
  return parts
    .map(
      (ln, i) =>
        padRight(ln, leftW) + padLeft(i === 0 ? rightText : '', rightW),
    )
    .join('\n');
}

export function encodeEscposText(s: string): Buffer {
  const normalized = String(s ?? '')
    .normalize('NFC')
    .replaceAll('•', '-')
    .replaceAll('€', 'EUR')
    .replaceAll('\u00A0', ' ');
  const out: number[] = [];
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out.push(code);
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      out.push(code);
      continue;
    }
    const mapped = PC850[ch];
    if (mapped != null) {
      out.push(mapped);
      continue;
    }
    const folded = ch.normalize('NFD').replace(/\p{M}/gu, '');
    if (folded && folded !== ch) {
      for (const f of folded) {
        const fc = f.codePointAt(0) ?? 0;
        if (fc >= 0x20 && fc <= 0x7e) out.push(fc);
        else if (PC850[f] != null) out.push(PC850[f]);
      }
      continue;
    }
    out.push(0x3f);
  }
  return Buffer.from(out);
}

/** ESC t 2 — select PC850. */
export const ESC_POS_PC850 = Buffer.from([0x1b, 0x74, 0x02]);
/** ESC M 0 — Font A (12×24), 48 glyphs across 80mm paper. */
export const ESC_POS_FONT_A = Buffer.from([0x1b, 0x4d, 0x00]);
/** ESC M 1 — Font B (9×17), smaller type for kitchen order lines. */
export const ESC_POS_FONT_B = Buffer.from([0x1b, 0x4d, 0x01]);

const GS = Buffer.from([0x1d]);

/**
 * QR Code: Model 2, error correction M, modules large enough for a phone.
 *
 * The previous sequence sent the *alignment* byte as the QR model
 * (`GS ( k … 0x41 n`). Center is 49, which is QR Model 1 — the 1994
 * variant phone cameras often refuse. Model 2 (n=50) is what every
 * scanner expects. Module size used to drop to 3 for long fiscal URLs,
 * which made the code too dense for thermal paper.
 */
export function escposQrCode(
  data: string,
  options?: { moduleSize?: number; paperMm?: ReceiptPaperMm },
): Buffer {
  const text = String(data || '');
  const d = Buffer.from(text, 'utf8');
  const storeLen = d.length + 3;
  const pL = storeLen & 0xff;
  const pH = (storeLen >> 8) & 0xff;
  let moduleSize = options?.moduleSize;
  if (moduleSize == null) {
    moduleSize = options?.paperMm === 58 ? 5 : 6;
  }
  moduleSize = Math.min(8, Math.max(5, Math.round(moduleSize)));
  return Buffer.concat([
    // Select model: Model 2, n2 = 0. Four-byte form per Epson.
    GS,
    Buffer.from([0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    // Module size (dots). Floor of 5 so a camera can resolve it.
    GS,
    Buffer.from([0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]),
    // Error correction M (15%) — thermal smudges eat L (7%).
    GS,
    Buffer.from([0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
    GS,
    Buffer.from([0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    d,
    GS,
    Buffer.from([0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
  ]);
}
