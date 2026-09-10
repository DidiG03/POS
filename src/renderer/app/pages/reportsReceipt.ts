export type ReportsTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

export function receiptLocationTitle(
  t: ReportsTranslate,
  hasTables: boolean,
  ticket: { area?: string | null; tableLabel?: string | null },
): string {
  if (hasTables) {
    const area = String(ticket?.area || '').trim();
    return `${area ? `${area} • ` : ''}${t('reports.receiptTable', {
      label: String(ticket?.tableLabel ?? ''),
    })}`;
  }
  return String(ticket?.tableLabel || '').trim() || t('reports.receiptSale');
}

export function receiptStaffLine(
  t: ReportsTranslate,
  hasTables: boolean,
  userName?: string | null,
): string {
  if (userName) {
    return t(hasTables ? 'common.waiterWithName' : 'common.cashierWithName', {
      name: String(userName),
    });
  }
  return `${t(hasTables ? 'common.waiter' : 'common.cashier')}: —`;
}
