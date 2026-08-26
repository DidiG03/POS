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
