/** Number fields of the admin menu editor (price, VAT, cost). */

/**
 * Price and cost as typed. A dot is the decimal point (the form is seeded
 * with prices that way). A comma is too, unless it groups thousands
 * ("1,500"). The fields used to drop commas, so "1,50" saved as 150.
 */
export function menuMoneyInput(raw: string): number {
  let s = String(raw || '').trim();
  if (s.includes('.') && s.includes(',')) {
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = s
      .split(decimal === ',' ? '.' : ',')
      .join('')
      .replace(decimal, '.');
  } else if (s.includes(',')) {
    const after = s.slice(s.lastIndexOf(',') + 1);
    s = after.length === 3 ? s.split(',').join('') : s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** VAT as a fraction (0.2). "0,2" and "20" (a percent) both mean 20%. */
export function menuVatInput(raw: string): number {
  const n = Number(String(raw).replace(',', '.').trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? n / 100 : n;
}

/** Keep digits and both separators while typing. */
export function menuNumberKeys(raw: string): string {
  return raw.replace(/[^0-9.,]/g, '');
}
