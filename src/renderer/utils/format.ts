export function makeFormatAmount() {
  return (n: number) => {
    const v = Number.isFinite(n) ? n : 0;
    const decimals = Math.abs(v - Math.round(v)) > 1e-9 ? 2 : 0;
    return v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
}

export function formatMoneyCompact(currency: string, amount: number) {
  const a = Number.isFinite(amount) ? amount : 0;
  const rounded = Math.round(a);
  const cur = String(currency || '').trim().toUpperCase();
  // Prefer ISO currency formatting when possible
  if (/^[A-Z]{3}$/.test(cur)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(rounded);
    } catch {
      // fall through
    }
  }
  // Fallback: treat short non-alnum as symbol (€, £, $)
  const looksSymbol = cur.length <= 2 && /[^A-Z0-9]/.test(cur);
  return looksSymbol ? `${cur}${rounded}` : `${cur || 'EUR'} ${rounded}`;
}

