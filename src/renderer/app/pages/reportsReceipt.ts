import type { PrintTicketInput } from '@shared/ipc';
import {
  fiscalOriginalVerifyUrl,
  isFiscalPending,
  isFiscalRegistered,
} from '@shared/fiscalReceipt';

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

export type ReportTicketFiscal = {
  fiscalEnabled?: boolean | null;
  fiscalNslf?: string | null;
  fiscalNivf?: string | null;
  fiscalEic?: string | null;
  fiscalLink?: string | null;
  fiscalQrCode?: string | null;
  fiscalTin?: string | null;
  fiscalStatus?: string | null;
  fiscalWarning?: string | null;
  paidAt?: string | null;
  createdAt?: string | null;
  total?: number | null;
};

/** True when the receipt should show fiskalizimi codes / pending state. */
export function reportTicketShowsFiscal(ticket: ReportTicketFiscal): boolean {
  const nslf = String(ticket.fiscalNslf || '').trim();
  const nivf = String(ticket.fiscalNivf || '').trim();
  const eic = String(ticket.fiscalEic || '').trim();
  if (nslf || nivf || eic) return true;
  if (ticket.fiscalEnabled !== true) return false;
  const meta = {
    fiscalStatus: ticket.fiscalStatus ?? undefined,
    fiscalNivf: ticket.fiscalNivf ?? undefined,
    fiscalNslf: ticket.fiscalNslf ?? undefined,
    fiscalLink: ticket.fiscalLink ?? undefined,
    fiscalWarning: ticket.fiscalWarning ?? undefined,
  };
  return isFiscalPending(meta) || isFiscalRegistered(meta);
}

/** CIS / provider verify URL for an expanded reports ticket. */
export function reportTicketVerifyUrl(
  ticket: ReportTicketFiscal,
): string | undefined {
  return fiscalOriginalVerifyUrl({
    fiscalNslf: ticket.fiscalNslf,
    fiscalLink: ticket.fiscalLink,
    fiscalQrCode: ticket.fiscalQrCode,
    fiscalTin: ticket.fiscalTin,
    closedAt: ticket.paidAt || ticket.createdAt,
    total: ticket.total,
  });
}

type ReportPrintItem = {
  sku?: string;
  name: string;
  qty: number;
  unitPrice: number;
  vatRate?: number;
  note?: string;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  categoryId?: number;
  categoryName?: string;
  courseId?: string | null;
  seatId?: string | null;
};

/** Live (non-voided) lines ready for {@link printTicket}. */
export function reportTicketPrintItems(ticket: {
  items?: unknown;
}): ReportPrintItem[] {
  const raw = Array.isArray(ticket?.items) ? ticket.items : [];
  const out: ReportPrintItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const row = it as Record<string, unknown>;
    if (row.voided === true) continue;
    const name = String(row.name || '').trim();
    if (!name) continue;
    const qty = Number(row.qty || 1);
    const unitPrice = Number(row.unitPrice || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const station = String(row.station || '').toUpperCase();
    out.push({
      sku: row.sku != null ? String(row.sku) : undefined,
      name,
      qty,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      vatRate:
        row.vatRate != null && Number.isFinite(Number(row.vatRate))
          ? Number(row.vatRate)
          : undefined,
      note: row.note != null ? String(row.note) : undefined,
      station:
        station === 'KITCHEN' || station === 'BAR' || station === 'DESSERT'
          ? station
          : undefined,
      categoryId:
        row.categoryId != null && Number.isFinite(Number(row.categoryId))
          ? Number(row.categoryId)
          : undefined,
      categoryName:
        row.categoryName != null ? String(row.categoryName) : undefined,
      courseId:
        row.courseId == null || row.courseId === ''
          ? null
          : String(row.courseId),
      seatId:
        row.seatId == null || row.seatId === '' ? null : String(row.seatId),
    });
  }
  return out;
}

/**
 * Guest-facing reprint of a reports ticket (active open sitting or paid sale).
 * Uses RECEIPT/PAYMENT so it goes to the receipt printer with prices — not a
 * kitchen ORDER split.
 */
export function buildReportPrintPayload(
  ticket: Record<string, unknown>,
  opts: { userId?: number | null; userName?: string | null },
): PrintTicketInput | null {
  const items = reportTicketPrintItems(ticket);
  if (!items.length) return null;
  const area = String(ticket.area || '').trim() || '—';
  const tableLabel = String(ticket.tableLabel || '').trim() || '—';
  const isPaid = String(ticket.kind || '').toUpperCase() === 'PAID';
  const vatEnabled = ticket.vatEnabled !== false;
  const total = Number(ticket.total || 0);
  const discountAmount = Number(ticket.discountAmount || 0);
  const serviceChargeAmount = Number(ticket.serviceChargeAmount || 0);
  const discountType = String(ticket.discountType || '').toUpperCase();
  const serviceMode = String(ticket.serviceChargeMode || '').toUpperCase();
  const fiscalNivf = String(ticket.fiscalNivf || '').trim();
  const fiscalNslf = String(ticket.fiscalNslf || '').trim();
  const fiscalLink = String(ticket.fiscalLink || '').trim();
  const fiscalQrCode = String(ticket.fiscalQrCode || '').trim();
  const fiscalTin = String(ticket.fiscalTin || '').trim();
  const fiscalEic = String(ticket.fiscalEic || '').trim();
  const fiscalStatus = String(ticket.fiscalStatus || '').trim();
  const fiscalWarning = String(ticket.fiscalWarning || '').trim();
  const fiscalEnabled =
    ticket.fiscalEnabled === true ||
    Boolean(fiscalNivf) ||
    Boolean(fiscalNslf) ||
    fiscalStatus.toLowerCase() === 'pending';

  return {
    area,
    tableLabel,
    covers:
      ticket.covers == null || !Number.isFinite(Number(ticket.covers))
        ? null
        : Number(ticket.covers),
    items,
    note: ticket.note != null ? String(ticket.note) : null,
    userName:
      String(opts.userName || ticket.userName || '').trim() || undefined,
    meta: {
      kind: isPaid ? 'PAYMENT' : 'RECEIPT',
      // Paid slips from Reports are guest reprints of an already-settled
      // sale — never re-fiscalize or require the table to still be open.
      // When the original payment was fiskalizuar, carry NSLF/NIVF/QR so
      // the reprint still prints as a registered fiscal receipt.
      reprint: isPaid ? true : undefined,
      closeTable: isPaid ? false : undefined,
      userId: opts.userId ?? null,
      vatEnabled,
      hidePrices: false,
      method: isPaid
        ? String(ticket.paymentMethod || '').trim() || undefined
        : undefined,
      paymentMethod: isPaid
        ? String(ticket.paymentMethod || '').trim() || undefined
        : undefined,
      paidAt: isPaid
        ? String(ticket.paidAt || ticket.createdAt || '') || undefined
        : undefined,
      total: Number.isFinite(total) ? total : undefined,
      totalAfter: Number.isFinite(total) ? total : undefined,
      totalBefore:
        Number.isFinite(total) && Number.isFinite(discountAmount)
          ? total + Math.max(0, discountAmount)
          : undefined,
      discountType:
        discountType === 'PERCENT' || discountType === 'AMOUNT'
          ? discountType
          : undefined,
      discountValue:
        ticket.discountValue != null &&
        Number.isFinite(Number(ticket.discountValue))
          ? Number(ticket.discountValue)
          : undefined,
      discountAmount:
        Number.isFinite(discountAmount) && discountAmount > 0
          ? discountAmount
          : undefined,
      discountReason:
        ticket.discountReason != null
          ? String(ticket.discountReason)
          : undefined,
      serviceChargeEnabled: ticket.serviceChargeEnabled ?? undefined,
      serviceChargeApplied:
        ticket.serviceChargeApplied ??
        (Number.isFinite(serviceChargeAmount) && serviceChargeAmount > 0),
      serviceChargeMode:
        serviceMode === 'PERCENT' || serviceMode === 'AMOUNT'
          ? serviceMode
          : undefined,
      serviceChargeValue:
        ticket.serviceChargeValue != null &&
        Number.isFinite(Number(ticket.serviceChargeValue))
          ? Number(ticket.serviceChargeValue)
          : undefined,
      serviceChargeAmount:
        Number.isFinite(serviceChargeAmount) && serviceChargeAmount > 0
          ? serviceChargeAmount
          : undefined,
      ...(isPaid && fiscalEnabled
        ? {
            fiscalEnabled: true,
            fiscalNslf: fiscalNslf || undefined,
            fiscalNivf: fiscalNivf || undefined,
            fiscalEic: fiscalEic || undefined,
            fiscalLink: fiscalLink || undefined,
            fiscalQrCode: fiscalQrCode || undefined,
            fiscalTin: fiscalTin || undefined,
            fiscalStatus: fiscalStatus || undefined,
            fiscalWarning: fiscalWarning || undefined,
          }
        : {}),
    },
  };
}
