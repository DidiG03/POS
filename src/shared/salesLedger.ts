/**
 * Pure helpers for the till sales ledger.
 *
 * A settled payment is one Order + its OrderItems + one Payment.
 * PrintJob stays the printer instruction; TicketLog stays the kitchen audit.
 */

import { isStoreCounterArea } from './editionCapabilities';
import { roundMoney } from './pricing';
import {
  effectiveVatRate,
  splitGrossVat,
  sumTicketLinesNetVat,
} from './ticketRevenue';
import { resolveVatEnabledFromMeta } from './vatFromFiscal';

export type LedgerPaymentMethod = 'CASH' | 'CARD' | 'MIXED';
export type LedgerOrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

export type LedgerLineInput = {
  sku?: string | null;
  name?: string | null;
  qty?: number | null;
  unitPrice?: number | null;
  vatRate?: number | null;
  note?: string | null;
  station?: string | null;
  categoryName?: string | null;
  courseId?: string | null;
  seatId?: string | null;
  voided?: boolean | null;
};

export type LedgerSaleFigures = {
  subtotal: number;
  vat: number;
  discountAmount: number;
  serviceChargeAmount: number;
  total: number;
  method: LedgerPaymentMethod;
  vatEnabled: boolean;
};

export function isPaymentPayload(payload: unknown): boolean {
  const meta = (payload as { meta?: { kind?: string } } | null)?.meta;
  return String(meta?.kind || '').toUpperCase() === 'PAYMENT';
}

export function normalizePaymentMethod(raw: unknown): LedgerPaymentMethod {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  if (v === 'CASH' || v === 'CARD' || v === 'MIXED') return v;
  return 'MIXED';
}

export function orderTypeFromArea(area?: string | null): LedgerOrderType {
  return isStoreCounterArea(area) ? 'TAKEAWAY' : 'DINE_IN';
}

export function parsePaidAt(raw: unknown, fallback: Date = new Date()): Date {
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw;
  const s = String(raw || '').trim();
  if (s) {
    const d = new Date(s);
    if (Number.isFinite(d.getTime())) return d;
  }
  return fallback;
}

export function saleFiguresFromPayload(
  payload: unknown,
  settings?: unknown,
): LedgerSaleFigures {
  const p = (payload as any) || {};
  const meta = (p?.meta as any) || {};
  const items = Array.isArray(p?.items) ? p.items : [];
  const vatEnabled = resolveVatEnabledFromMeta(meta, settings);
  const defaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  const { net: subtotal, vat } = sumTicketLinesNetVat(
    items,
    vatEnabled,
    defaultVatRate,
  );
  const serviceChargeAmount = roundMoney(meta.serviceChargeAmount || 0);
  const discountAmount = roundMoney(meta.discountAmount || 0);
  const fallbackTotal = Math.max(
    0,
    roundMoney(subtotal + vat + serviceChargeAmount - discountAmount),
  );
  const totalAfter = Number(meta.totalAfter);
  const total = Number.isFinite(totalAfter)
    ? Math.max(0, roundMoney(totalAfter))
    : fallbackTotal;
  return {
    subtotal: roundMoney(subtotal),
    vat: roundMoney(vat),
    discountAmount,
    serviceChargeAmount,
    total,
    method: normalizePaymentMethod(meta.method || meta.paymentMethod),
    vatEnabled,
  };
}

export function ledgerLinesFromPayload(payload: unknown): LedgerLineInput[] {
  const items = Array.isArray((payload as any)?.items)
    ? ((payload as any).items as any[])
    : [];
  const out: LedgerLineInput[] = [];
  for (const it of items) {
    if (it?.voided) continue;
    const qty = Number(it?.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      sku: it?.sku ?? null,
      name: it?.name ?? null,
      qty,
      unitPrice: Number(it?.unitPrice || 0),
      vatRate: it?.vatRate ?? null,
      note: it?.note ?? null,
      station: it?.station ?? null,
      categoryName: it?.categoryName ?? null,
      courseId: it?.courseId ?? null,
      seatId: it?.seatId ?? null,
    });
  }
  return out;
}

/** Line VAT for a stored qty × unitPrice (gross, VAT-inclusive). */
export function lineVatAmount(
  qty: number,
  unitPrice: number,
  vatRate: number,
  vatEnabled: boolean,
): { net: number; vat: number; gross: number } {
  const gross = roundMoney(Number(qty || 0) * Number(unitPrice || 0));
  if (!vatEnabled) return { net: gross, vat: 0, gross };
  const rate = effectiveVatRate(vatRate, 0);
  const split = splitGrossVat(gross, rate);
  return {
    net: roundMoney(split.net),
    vat: roundMoney(split.vat),
    gross,
  };
}

export function cashChangeDue(amountPaid: unknown, total: number): number {
  const tendered = Number(amountPaid);
  if (!Number.isFinite(tendered) || tendered <= 0) return 0;
  return roundMoney(Math.max(0, tendered - Number(total || 0)));
}
