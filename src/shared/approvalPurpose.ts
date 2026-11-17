/**
 * What a manager approved, for a payment.
 *
 * A payment approval was claimed for "a payment at this table" and could
 * be reused by any payment there for its five minutes, and it did not say
 * what it approved: a 10% discount approved for one guest let the next
 * payments at that table through at 100%. Now:
 *   - each approval is bound, on first use, to that payment's adjustments
 *     and bill total (`paymentApprovalFingerprint`): a retry of the same
 *     payment may reuse it, another payment may not;
 *   - the Pay screen sends what the manager is approving with the PIN
 *     (`PaymentApprovalPurpose`), the approval carries it, and a payment
 *     that does not match it is refused (`purposeAllowsPayment`).
 */

export interface PaymentApprovalPurpose {
  action: 'PAYMENT';
  area: string;
  tableLabel: string;
  discountType: 'PERCENT' | 'AMOUNT' | 'NONE';
  /** The percentage, or the amount, of the discount; null when none. */
  discountValue: number | null;
  serviceChargeRemoved: boolean;
  /** The bill before the discount, as the manager saw it. */
  totalBefore: number;
}

const cents = (n: unknown) => Math.round(Number(n || 0) * 100);

function discountTypeOf(raw: unknown): PaymentApprovalPurpose['discountType'] {
  const t = String(raw || '').toUpperCase();
  return t === 'PERCENT' || t === 'AMOUNT' ? t : 'NONE';
}

/** True when this payment takes the service charge off. */
export function paymentRemovesServiceCharge(
  settings: unknown,
  meta: Record<string, any> | null | undefined,
): boolean {
  const sc = (settings as any)?.preferences?.serviceCharge || {};
  return (
    sc.enabled === true &&
    Number(sc.value) > 0 &&
    Number(meta?.baseTotal) > 0.005 &&
    !(Number(meta?.serviceChargeAmount) > 0.005)
  );
}

/** A purpose read from a request, or null when it is not one. */
export function parsePaymentApprovalPurpose(
  raw: unknown,
): PaymentApprovalPurpose | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || p.action !== 'PAYMENT') return null;
  const area = String(p.area ?? '').trim();
  const tableLabel = String(p.tableLabel ?? '').trim();
  const totalBefore = Number(p.totalBefore);
  if (!area || !tableLabel || !Number.isFinite(totalBefore)) return null;
  const discountType = discountTypeOf(p.discountType);
  const value = Number(p.discountValue);
  return {
    action: 'PAYMENT',
    area,
    tableLabel,
    discountType,
    discountValue:
      discountType === 'NONE' || !Number.isFinite(value) ? null : value,
    serviceChargeRemoved: p.serviceChargeRemoved === true,
    totalBefore,
  };
}

/**
 * What one payment's approval is bound to: its adjustments and its bill.
 * A retry of the same payment (a new key after a fiscal hiccup) has the
 * same fingerprint; another seat's or another bill's payment does not.
 */
export function paymentApprovalFingerprint(
  settings: unknown,
  meta: Record<string, any> | null | undefined,
): string {
  const type = discountTypeOf(meta?.discountType);
  const value =
    type === 'NONE'
      ? ''
      : String(Math.round(Number(meta?.discountValue) * 1000));
  return [
    type,
    value,
    paymentRemovesServiceCharge(settings, meta) ? 'sc-off' : 'sc',
    meta?.fiscalRefusalDefer === true ? 'defer' : '',
    String(cents(meta?.totalBefore)),
  ].join('~');
}

/** True when `meta` (the till's totals) is the payment the manager approved. */
export function purposeAllowsPayment(
  purpose: PaymentApprovalPurpose,
  input: {
    settings: unknown;
    area: string;
    tableLabel: string;
    meta: Record<string, any> | null | undefined;
  },
): boolean {
  if (purpose.area !== String(input.area).trim()) return false;
  if (purpose.tableLabel !== String(input.tableLabel).trim()) return false;
  const type = discountTypeOf(input.meta?.discountType);
  const discounted = Number(input.meta?.discountAmount) > 0.005;
  if (discounted) {
    if (purpose.discountType !== type) return false;
    const value = Number(input.meta?.discountValue);
    if (
      purpose.discountValue == null ||
      !Number.isFinite(value) ||
      Math.abs(purpose.discountValue - value) > 0.0005
    ) {
      return false;
    }
  }
  if (
    paymentRemovesServiceCharge(input.settings, input.meta) &&
    !purpose.serviceChargeRemoved
  ) {
    return false;
  }
  // The bill the manager saw: a bigger bill is a different payment.
  return (
    Math.abs(cents(purpose.totalBefore) - cents(input.meta?.totalBefore)) <= 1
  );
}
