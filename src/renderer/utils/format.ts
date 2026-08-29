export function makeFormatAmount() {
  return (n: number) => {
    const v = Number.isFinite(n) ? n : 0;
    const decimals = Math.abs(v - Math.round(v)) > 1e-9 ? 2 : 0;
    return v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
}

/** Euro always shows cents — waiters quote it to guests paying in EUR. */
export function formatEur(amount: number): string {
  const v = Number.isFinite(amount) ? amount : 0;
  return `€${v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Format a number with at most `maxFractionDigits` decimal places (avoids float noise). */
export function formatNumberMaxDecimals(
  n: number,
  maxFractionDigits = 1,
): string {
  if (!Number.isFinite(n)) return '—';
  const factor = 10 ** maxFractionDigits;
  const rounded = Math.round(n * factor) / factor;
  return rounded.toLocaleString(undefined, {
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: 0,
  });
}

export function formatMoneyCompact(currency: string, amount: number) {
  const a = Number.isFinite(amount) ? amount : 0;
  const rounded = Math.round(a);
  const cur = String(currency || '')
    .trim()
    .toUpperCase();
  // Prefer ISO currency formatting when possible
  if (/^[A-Z]{3}$/.test(cur)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: cur,
        maximumFractionDigits: 0,
      }).format(rounded);
    } catch {
      // fall through
    }
  }
  // Fallback: treat short non-alnum as symbol (€, £, $)
  const looksSymbol = cur.length <= 2 && /[^A-Z0-9]/.test(cur);
  return looksSymbol ? `${cur}${rounded}` : `${cur || 'EUR'} ${rounded}`;
}
