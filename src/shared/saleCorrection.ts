/**
 * Working out what an admin's reversal of a settled sale actually changes.
 *
 * Two shapes, because the tax service recognises two documents. A
 * cancellation withdraws the whole invoice. A corrective invoice strikes
 * some of its lines and leaves the rest standing. Both are new documents
 * referencing the original — the original sale is never edited away, which
 * is why this returns the *delta* rather than a rewritten invoice.
 *
 * The money is what the guest paid for the struck lines, not their menu
 * price: a percentage discount or service charge scales with the dishes, so
 * striking a 1,000 dish from a bill with 10% off gives back 900. Fixed
 * amounts stay with the bill (capped at what is left to discount). The
 * change is applied to the sale's own total, so a bill whose stored figures
 * never added up exactly keeps that difference instead of losing it.
 */
import { roundMoney } from './pricing';
import { splitChargedNetVat } from './ticketRevenue';

export type SaleCorrectionKind = 'CANCEL' | 'CORRECTIVE';

export type CorrectionOrderLine = {
  id: number;
  name?: string | null;
  qty?: number | null;
  unitPrice?: number | null;
  vatRate?: number | null;
  /** Already struck off by an earlier correction. */
  voidedAt?: Date | string | null;
};

export type CorrectionOrderSnapshot = {
  status?: string | null;
  total?: number | null;
  vatEnabled?: boolean | null;
  items: readonly CorrectionOrderLine[];
  /** The bill's service charge as it stands now. */
  serviceChargeAmount?: number | null;
  /**
   * How it was worked out. A fixed charge stays with the bill; a
   * percentage (and an unknown mode) scales with the dishes.
   */
  serviceChargeMode?: 'PERCENT' | 'AMOUNT' | null;
  /** The bill's discount as it stands now. */
  discountAmount?: number | null;
  /** PERCENT scales with the dishes; anything else is a fixed amount. */
  discountType?: string | null;
};

export type SaleCorrectionRequest = {
  kind: SaleCorrectionKind;
  /** Which lines a CORRECTIVE strikes. Ignored by CANCEL. */
  itemIds?: readonly number[] | null;
  reason: string;
};

export type SaleCorrectionError =
  /** Corrections are an audit trail; an unexplained one is worthless. */
  | 'reason-required'
  /** Only a settled sale can be reversed. */
  | 'not-paid'
  /** Someone already reversed this invoice. */
  | 'already-void'
  /** A CORRECTIVE that names no line changes nothing. */
  | 'no-lines'
  | 'unknown-line'
  | 'line-already-void'
  /** Striking every remaining line is a cancellation; file it as one. */
  | 'use-cancel';

/**
 * HTTP status for a correction answer. A repeat of the same request (same
 * key) gets the first answer back; a different request for an invoice or
 * line that was already reversed is a conflict, not a success.
 */
export function saleCorrectionHttpStatus(
  result: { ok: boolean; error?: string } | null | undefined,
): 200 | 409 {
  if (result && result.ok === false) {
    if (result.error === 'already-void' || result.error === 'line-already-void')
      return 409;
  }
  return 200;
}

export type SaleCorrectionPlan = {
  kind: SaleCorrectionKind;
  reason: string;
  struckItemIds: number[];
  struckLines: CorrectionOrderLine[];
  /** Negative — what comes off the original invoice. */
  amountDelta: number;
  /** Totals the sale carries once the correction is filed. */
  nextTotal: number;
  nextSubtotal: number;
  nextVat: number;
  /** Service charge and discount the sale carries afterwards. */
  nextServiceCharge: number;
  nextDiscount: number;
  /**
   * The part of the service charge that goes with the struck lines. The
   * corrective invoice strikes it next to them, as the original filed it.
   */
  struckServiceCharge: number;
  /** True when nothing of the sale survives. */
  cancelsSale: boolean;
};

export const MIN_CORRECTION_REASON_LENGTH = 3;

function isStruck(line: CorrectionOrderLine): boolean {
  return line.voidedAt != null && String(line.voidedAt) !== '';
}

export function lineGross(line: CorrectionOrderLine): number {
  const qty = Number(line.qty);
  const unitPrice = Number(line.unitPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) return 0;
  return roundMoney(qty * unitPrice);
}

type BillCharges = {
  base: number;
  service: number;
  discount: number;
  total: number;
};

/**
 * What the bill would come to with only `lines` on it, by the rules it was
 * charged with. On the lines still standing this reproduces the stored
 * service charge and discount exactly; a percentage is applied as the ratio
 * the bill actually carries, so no rate has to be stored or re-read.
 */
function chargesFor(
  lines: readonly CorrectionOrderLine[],
  live: readonly CorrectionOrderLine[],
  order: CorrectionOrderSnapshot,
): BillCharges {
  const sum = (ls: readonly CorrectionOrderLine[]) =>
    roundMoney(ls.reduce((t, l) => t + lineGross(l), 0));
  const positive = (v: unknown) => Math.max(0, roundMoney(Number(v) || 0));
  const liveBase = sum(live);
  const base = sum(lines);
  const liveService = positive(order.serviceChargeAmount);
  const service =
    order.serviceChargeMode === 'AMOUNT'
      ? liveService
      : liveBase > 0
        ? roundMoney((base * liveService) / liveBase)
        : 0;
  const liveBefore = roundMoney(liveBase + liveService);
  const before = roundMoney(base + service);
  const liveDiscount = Math.min(positive(order.discountAmount), liveBefore);
  const percent = String(order.discountType || '').toUpperCase() === 'PERCENT';
  const discount = percent
    ? liveBefore > 0
      ? Math.min(before, roundMoney((before * liveDiscount) / liveBefore))
      : 0
    : Math.min(liveDiscount, before);
  return {
    base,
    service,
    discount,
    total: roundMoney(Math.max(0, before - discount)),
  };
}

export function planSaleCorrection(
  order: CorrectionOrderSnapshot,
  request: SaleCorrectionRequest,
  options?: { defaultVatRate?: number },
):
  | { ok: true; plan: SaleCorrectionPlan }
  | { ok: false; error: SaleCorrectionError } {
  const reason = String(request.reason || '').trim();
  if (reason.length < MIN_CORRECTION_REASON_LENGTH) {
    return { ok: false, error: 'reason-required' };
  }

  const status = String(order.status || '').toUpperCase();
  if (status === 'VOID') return { ok: false, error: 'already-void' };
  if (status !== 'PAID') return { ok: false, error: 'not-paid' };

  const lines = Array.isArray(order.items) ? order.items : [];
  const live = lines.filter((l) => !isStruck(l));
  const originalTotal = Math.max(0, roundMoney(Number(order.total) || 0));

  let struck: CorrectionOrderLine[];
  if (request.kind === 'CANCEL') {
    struck = [...live];
  } else {
    const wanted = [
      ...new Set((request.itemIds || []).map((id) => Number(id))),
    ];
    if (wanted.length === 0) return { ok: false, error: 'no-lines' };
    struck = [];
    for (const id of wanted) {
      const line = lines.find((l) => Number(l.id) === id);
      if (!line) return { ok: false, error: 'unknown-line' };
      if (isStruck(line)) return { ok: false, error: 'line-already-void' };
      struck.push(line);
    }
    if (struck.length === live.length)
      return { ok: false, error: 'use-cancel' };
  }

  const struckIds = new Set(struck.map((l) => Number(l.id)));
  const remaining = live.filter((l) => !struckIds.has(Number(l.id)));
  const vatEnabled = order.vatEnabled === true;
  const cancelsSale = request.kind === 'CANCEL' || remaining.length === 0;
  const before = chargesFor(live, live, order);
  const after = cancelsSale
    ? { base: 0, service: 0, discount: 0, total: 0 }
    : chargesFor(remaining, live, order);
  const amountDelta = cancelsSale
    ? roundMoney(-originalTotal)
    : roundMoney(
        -Math.min(Math.max(0, before.total - after.total), originalTotal),
      );
  // VAT of what the sale still totals, not of the remaining lines at menu
  // price — the discount / service charge stay on the restated sale.
  const { net, vat } = splitChargedNetVat(
    remaining as any,
    roundMoney(originalTotal + amountDelta),
    vatEnabled,
    Number(options?.defaultVatRate || 0),
  );

  return {
    ok: true,
    plan: {
      kind: request.kind,
      reason,
      struckItemIds: struck.map((l) => Number(l.id)),
      struckLines: struck,
      amountDelta,
      nextTotal: cancelsSale ? 0 : roundMoney(originalTotal + amountDelta),
      nextSubtotal: cancelsSale ? 0 : roundMoney(net),
      nextVat: cancelsSale ? 0 : roundMoney(vat),
      nextServiceCharge: after.service,
      nextDiscount: after.discount,
      struckServiceCharge: roundMoney(
        Math.max(0, before.service - after.service),
      ),
      cancelsSale,
    },
  };
}
