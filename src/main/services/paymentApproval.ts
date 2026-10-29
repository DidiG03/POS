/**
 * Manager approval for payment adjustments, checked on the till.
 *
 * The Pay screen asks for a manager PIN before a discount or before taking
 * the service charge off, but the payment used to carry only the manager's
 * id. Any phone could send a 100% discount with an admin id it read off the
 * login screen, and the till recorded the sale at zero. The till now checks
 * the signed approval the PIN prompt hands back, the same proof a void needs.
 *
 * Runs on the host-computed totals (`applyAuthoritativeTotals`), so the
 * client cannot hide a discount by mislabelling it.
 */
import type { PrintTicketErr } from './paymentSettle';

export type PaymentAdjustment =
  | 'discount'
  | 'serviceChargeRemoval'
  /** Take a payment fiskalizimi refused; its invoice goes to review. */
  | 'fiscalRefusalDefer';

const EPS = 0.005;

/** Adjustments in this payment that the venue's settings put behind a PIN. */
export function paymentApprovalsNeeded(
  settings: any,
  meta: Record<string, any> | null | undefined,
): PaymentAdjustment[] {
  const m = meta || {};
  if (String(m.kind || '').toUpperCase() !== 'PAYMENT') return [];
  if (m.reprint === true) return [];
  const approvals = settings?.security?.approvals || {};
  const needed: PaymentAdjustment[] = [];
  if (
    approvals.requireManagerPinForDiscount !== false &&
    Number(m.discountAmount) > EPS
  ) {
    needed.push('discount');
  }
  const sc = settings?.preferences?.serviceCharge || {};
  if (
    approvals.requireManagerPinForServiceChargeRemoval !== false &&
    sc.enabled === true &&
    Number(sc.value) > 0 &&
    Number(m.baseTotal) > EPS &&
    !(Number(m.serviceChargeAmount) > EPS)
  ) {
    needed.push('serviceChargeRemoval');
  }
  // Always behind a PIN, whatever the venue's settings: it takes money for
  // a sale the tax service has not accepted.
  if (m.fiscalRefusalDefer === true) needed.push('fiscalRefusalDefer');
  return needed;
}

export function paymentApprovalRefusal(
  needed: PaymentAdjustment[],
): PrintTicketErr {
  const what = needed
    .map((n) =>
      n === 'discount'
        ? 'discount'
        : n === 'serviceChargeRemoval'
          ? 'service charge removal'
          : 'payment fiskalizimi refused',
    )
    .join(' and ');
  return {
    ok: false,
    code: 'APPROVAL_REQUIRED',
    // A replay carries the same missing approval; the waiter has to ask a
    // manager again from the Pay screen.
    permanent: true,
    error: `A manager PIN is required for the ${what}. Ask a manager to approve it and charge again.`,
  };
}

/**
 * Null when the payment may go ahead. `approvalIsValid` checks the token
 * against the admin id with the caller's own token scheme (the till and the
 * LAN API sign approvals differently).
 */
export async function checkPaymentApproval(input: {
  settings: any;
  meta: Record<string, any> | null | undefined;
  actorIsAdmin: boolean;
  approvalIsValid: (token: string, adminId: number) => Promise<boolean>;
}): Promise<PrintTicketErr | null> {
  const needed = paymentApprovalsNeeded(input.settings, input.meta);
  if (needed.length === 0 || input.actorIsAdmin) return null;
  const m = input.meta || {};
  const token = String(m.managerApprovalToken || '').trim();
  const adminId = Number(m.managerApprovedById || 0);
  if (token && adminId > 0 && (await input.approvalIsValid(token, adminId))) {
    return null;
  }
  return paymentApprovalRefusal(needed);
}
