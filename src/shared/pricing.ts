/**
 * Authoritative payment pricing.
 *
 * Every client that can take a payment — the Electron renderer, the LAN
 * browser client, and the Capacitor iOS/Android tablets — computes a
 * running total locally so the cashier sees live figures. That total is
 * a DISPLAY value only. It arrives at the host inside `meta` and must
 * never be the number that gets printed, recorded, or fiscalized.
 *
 * The host recomputes the total here from the line items it is about to
 * print plus its own settings, and prints that instead. A client can
 * still decide *what* is on the ticket (that is the order) and whether
 * an optional service charge applies, but it cannot decide what those
 * items add up to.
 *
 * The formulas mirror the renderer exactly so an honest client always
 * agrees to the cent and `validatePaymentTotals` stays quiet:
 *
 *   base    = Σ(unitPrice × qty) over non-voided lines   (VAT-inclusive)
 *   service = enabled && applied ? (PERCENT ? base×v/100 : v) : 0
 *   before  = base + service
 *   discount= PERCENT ? before×v/100 : v      (clamped to `before`)
 *   total   = before − discount
 */

import {
  liveTicketLines,
  effectiveVatRate,
  splitGrossVat,
} from './ticketRevenue';

/** Largest accepted gap between a client's claimed total and ours. */
export const TOTAL_TOLERANCE = 0.01;

export type DiscountType = 'PERCENT' | 'AMOUNT' | 'NONE';
export type ChargeMode = 'PERCENT' | 'AMOUNT';

export interface ServiceChargeConfig {
  enabled?: boolean;
  mode?: ChargeMode;
  value?: number;
}

export interface AuthoritativeTotals {
  /** VAT-inclusive sum of live line items. */
  baseTotal: number;
  /** Net portion of `baseTotal` (gross minus contained VAT). */
  net: number;
  /** VAT contained within `baseTotal`. */
  vat: number;
  serviceChargeAmount: number;
  /** `baseTotal + serviceChargeAmount`, before any discount. */
  totalBefore: number;
  discountAmount: number;
  /** The amount actually owed. This is the only total safe to print. */
  totalDue: number;
}

/**
 * Round to cents. The epsilon nudge keeps values that land just under a
 * half-cent because of binary representation (1.005 stored as
 * 1.00499999…) rounding up the way an accountant expects.
 */
export function roundMoney(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Coerce to a finite, non-negative number. */
function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** VAT-inclusive sum of every non-voided line. */
export function sumLineItemsGross(itemsJson: unknown): number {
  let gross = 0;
  for (const line of liveTicketLines(itemsJson)) {
    const qty = Number((line as any)?.qty ?? 1);
    const unit = Number((line as any)?.unitPrice ?? 0);
    if (!Number.isFinite(qty) || !Number.isFinite(unit)) continue;
    gross += unit * qty;
  }
  return roundMoney(gross);
}

export function computeServiceChargeAmount(
  base: number,
  config: ServiceChargeConfig | null | undefined,
  applied: boolean,
): number {
  if (!config?.enabled || !applied) return 0;
  const b = positive(base);
  const v = positive(config.value);
  if (!b || !v) return 0;
  return roundMoney(config.mode === 'PERCENT' ? (b * v) / 100 : v);
}

/** Discount never exceeds the amount it is applied to. */
export function computeDiscountAmount(
  base: number,
  type: DiscountType | null | undefined,
  value: unknown,
): number {
  const b = positive(base);
  const v = positive(value);
  if (!b || !v) return 0;
  if (type === 'PERCENT') return roundMoney(Math.min(b, (b * v) / 100));
  if (type === 'AMOUNT') return roundMoney(Math.min(b, v));
  return 0;
}

/**
 * Recompute a payment from the line items and the host's own settings.
 *
 * `serviceChargeApplied` and the discount are the only client inputs
 * honoured, and both are re-derived from server-side configuration
 * rather than trusted as amounts.
 */
export function computeAuthoritativeTotals(input: {
  items: unknown;
  vatEnabled?: boolean;
  defaultVatRate?: number;
  serviceCharge?: ServiceChargeConfig | null;
  serviceChargeApplied?: boolean;
  discountType?: DiscountType | null;
  discountValue?: unknown;
}): AuthoritativeTotals {
  const vatEnabled = input.vatEnabled !== false;
  const defaultVatRate = Number(input.defaultVatRate ?? 0);

  let gross = 0;
  let vat = 0;
  for (const line of liveTicketLines(input.items)) {
    const qty = Number((line as any)?.qty ?? 1);
    const unit = Number((line as any)?.unitPrice ?? 0);
    if (!Number.isFinite(qty) || !Number.isFinite(unit)) continue;
    const lineGross = unit * qty;
    gross += lineGross;
    if (vatEnabled) {
      const rate = effectiveVatRate((line as any)?.vatRate, defaultVatRate);
      vat += splitGrossVat(lineGross, rate).vat;
    }
  }

  const baseTotal = roundMoney(gross);
  const vatAmount = roundMoney(vat);
  const serviceChargeAmount = computeServiceChargeAmount(
    baseTotal,
    input.serviceCharge,
    Boolean(input.serviceChargeApplied),
  );
  const totalBefore = roundMoney(Math.max(0, baseTotal + serviceChargeAmount));
  const discountAmount = computeDiscountAmount(
    totalBefore,
    input.discountType ?? 'NONE',
    input.discountValue,
  );
  const totalDue = roundMoney(Math.max(0, totalBefore - discountAmount));

  return {
    baseTotal,
    net: roundMoney(baseTotal - vatAmount),
    vat: vatAmount,
    serviceChargeAmount,
    totalBefore,
    discountAmount,
    totalDue,
  };
}

export interface TotalsValidation {
  /** True when the client's figures matched ours to the cent. */
  ok: boolean;
  /** Host-computed figures. Always safe to print. */
  computed: AuthoritativeTotals;
  /** What the client asked us to print, when it sent a usable number. */
  claimedTotal: number | null;
  /** Signed drift (`claimed − computed`), for the audit trail. */
  delta: number;
  /** Human-readable divergence summary; `null` when `ok`. */
  mismatch: string | null;
}

/**
 * Compare a client's claimed payment figures against a fresh
 * computation. The caller should always print `computed`; `mismatch`
 * exists so a divergence can be surfaced and recorded rather than
 * silently absorbed.
 */
export function validatePaymentTotals(
  items: unknown,
  meta: Record<string, any> | null | undefined,
  options: {
    vatEnabled?: boolean;
    defaultVatRate?: number;
    serviceCharge?: ServiceChargeConfig | null;
  },
): TotalsValidation {
  const m = meta || {};
  const computed = computeAuthoritativeTotals({
    items,
    vatEnabled: options.vatEnabled,
    defaultVatRate: options.defaultVatRate,
    serviceCharge: options.serviceCharge,
    // An absent flag means "apply it" only when the venue has the charge
    // switched on; the renderer always sends an explicit boolean.
    serviceChargeApplied:
      m.serviceChargeApplied ?? Boolean(options.serviceCharge?.enabled),
    discountType: (m.discountType as DiscountType) ?? 'NONE',
    discountValue: m.discountValue,
  });

  const rawClaim = Number(m.totalAfter);
  const claimedTotal = Number.isFinite(rawClaim) ? roundMoney(rawClaim) : null;
  if (claimedTotal === null) {
    return { ok: true, computed, claimedTotal: null, delta: 0, mismatch: null };
  }

  const delta = roundMoney(claimedTotal - computed.totalDue);
  if (Math.abs(delta) <= TOTAL_TOLERANCE) {
    return { ok: true, computed, claimedTotal, delta, mismatch: null };
  }

  const parts = [
    `total ${claimedTotal.toFixed(2)} vs ${computed.totalDue.toFixed(2)}`,
  ];
  const claimedBase = Number(m.baseTotal);
  if (
    Number.isFinite(claimedBase) &&
    Math.abs(roundMoney(claimedBase) - computed.baseTotal) > TOTAL_TOLERANCE
  ) {
    parts.push(
      `items ${roundMoney(claimedBase).toFixed(2)} vs ${computed.baseTotal.toFixed(2)}`,
    );
  }
  const claimedDiscount = Number(m.discountAmount);
  if (
    Number.isFinite(claimedDiscount) &&
    Math.abs(roundMoney(claimedDiscount) - computed.discountAmount) >
      TOTAL_TOLERANCE
  ) {
    parts.push(
      `discount ${roundMoney(claimedDiscount).toFixed(2)} vs ${computed.discountAmount.toFixed(2)}`,
    );
  }
  const claimedService = Number(m.serviceChargeAmount);
  if (
    Number.isFinite(claimedService) &&
    Math.abs(roundMoney(claimedService) - computed.serviceChargeAmount) >
      TOTAL_TOLERANCE
  ) {
    parts.push(
      `service ${roundMoney(claimedService).toFixed(2)} vs ${computed.serviceChargeAmount.toFixed(2)}`,
    );
  }

  return {
    ok: false,
    computed,
    claimedTotal,
    delta,
    mismatch: parts.join(', '),
  };
}

/**
 * Overwrite a payment `meta` with host-computed figures.
 *
 * Returns a new meta object; when the client's numbers diverged the
 * original claim is preserved under `totalsMismatch` so the discrepancy
 * survives into the `PrintJob` audit row.
 */
export function applyAuthoritativeTotals<T extends Record<string, any>>(
  meta: T | null | undefined,
  validation: TotalsValidation,
): T {
  const { computed, mismatch, claimedTotal, delta } = validation;
  const next: Record<string, any> = { ...(meta || {}) };

  next.baseTotal = computed.baseTotal;
  next.serviceChargeAmount = computed.serviceChargeAmount;
  next.totalBefore = computed.totalBefore;
  next.discountAmount = computed.discountAmount;
  next.totalAfter = computed.totalDue;

  if (mismatch) {
    next.totalsMismatch = {
      claimedTotal,
      computedTotal: computed.totalDue,
      delta,
      detail: mismatch,
      at: new Date().toISOString(),
    };
  }
  return next as T;
}
