export function mapVatRateToCode(vatRate: number): string {
  const r = Number(vatRate);
  if (!Number.isFinite(r) || r <= 0) return 'A';
  if (r >= 0.19) return 'B';
  if (r >= 0.09) return 'D';
  if (r >= 0.05) return 'E';
  return 'A';
}

export function mapPaymentMethod(method: string): string {
  const m = String(method || '')
    .trim()
    .toUpperCase();
  if (m === 'CASH') return 'CASH';
  if (m === 'CARD') return 'CARD';
  if (m === 'CHECK') return 'CHECK';
  return 'OTHER';
}
