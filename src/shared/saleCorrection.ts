/**
 * Working out what an admin's reversal of a settled sale actually changes.
 *
 * Two shapes, because the tax service recognises two documents. A
 * cancellation withdraws the whole invoice. A corrective invoice strikes
 * some of its lines and leaves the rest standing. Both are new documents
 * referencing the original — the original sale is never edited away, which
 * is why this returns the *delta* rather than a rewritten invoice.
 *
 * The money is computed off the original total rather than re-derived from
 * scratch: a bill can carry a whole-ticket discount or a service charge
 * whose split across lines nobody recorded, and inventing that split here
 * would make the corrective document disagree with the invoice it corrects.
 * Striking a line takes exactly that line's gross off the total.
 */
import { roundMoney } from './pricing';
import { sumTicketLinesNetVat } from './ticketRevenue';

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
  const { net, vat } = sumTicketLinesNetVat(
    remaining as any,
    vatEnabled,
    Number(options?.defaultVatRate || 0),
  );

  const cancelsSale = request.kind === 'CANCEL' || remaining.length === 0;
  const struckGross = roundMoney(
    struck.reduce((sum, l) => sum + lineGross(l), 0),
  );
  const amountDelta = cancelsSale
    ? roundMoney(-originalTotal)
    : roundMoney(-Math.min(struckGross, originalTotal));

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
      cancelsSale,
    },
  };
}
