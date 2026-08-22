/**
 * Host-side enforcement of payment totals.
 *
 * The figures a client sends are advisory. Before anything is printed,
 * recorded, or fiscalized we recompute the payment from the line items
 * on the ticket plus this host's own settings, and substitute the
 * result. Both payment entry points route through here:
 *
 *   - `tickets:print` IPC          → the Electron cashier
 *   - `POST /print/ticket`         → LAN browser + Capacitor iOS/Android
 *
 * The tablets matter most: they are separate devices on the venue Wi-Fi
 * that can run a stale bundle or be tampered with, so their arithmetic
 * cannot be taken on trust.
 *
 * A divergence is never a reason to refuse a customer's payment — the
 * corrected total is printed and the discrepancy is raised to admins
 * and written into the `PrintJob` audit row instead.
 */

import { prisma } from '@db/client';
import {
  applyAuthoritativeTotals,
  validatePaymentTotals,
  type TotalsValidation,
} from '@shared/pricing';
import { resolveVatEnabledFromMeta } from '@shared/vatFromFiscal';

export interface EnforceTotalsResult {
  /** Payload with `meta` totals replaced by host-computed values. */
  payload: any;
  /** `null` when the ticket is not a payment. */
  validation: TotalsValidation | null;
  /** Divergence summary, `null` when the client agreed with us. */
  mismatch: string | null;
}

function isPayment(payload: any): boolean {
  return String(payload?.meta?.kind || '').toUpperCase() === 'PAYMENT';
}

/**
 * Persist a tampering/drift signal for every admin plus the acting
 * waiter. Best-effort: an audit write must never stop a payment.
 */
async function recordMismatch(
  payload: any,
  validation: TotalsValidation,
  source: string,
): Promise<void> {
  const area = String(payload?.area || '');
  const tableLabel = String(payload?.tableLabel || '');
  const who = String(payload?.userName || '').trim();
  const message =
    `Payment total mismatch on ${area} Table ${tableLabel}` +
    `${who ? ` (${who})` : ''}: ${validation.mismatch}. ` +
    `Printed the recomputed total ${validation.computed.totalDue.toFixed(2)}. ` +
    `Source: ${source}.`;

  try {
    console.error(`[paymentTotals] ${message}`);
  } catch {
    // ignore
  }

  try {
    const recipients = new Set<number>();
    const actorId = Number(payload?.meta?.userId || 0);
    if (actorId) recipients.add(actorId);
    const admins = await prisma.user
      .findMany({
        where: { role: 'ADMIN', active: true },
        select: { id: true },
      } as any)
      .catch(() => [] as any[]);
    for (const a of admins as any[]) {
      const id = Number(a?.id || 0);
      if (id) recipients.add(id);
    }
    for (const userId of recipients) {
      await prisma.notification
        .create({
          data: { userId, type: 'SECURITY' as any, message } as any,
        })
        .catch(() => {});
    }
  } catch {
    // Audit is advisory — never block the sale on it.
  }
}

/**
 * Recompute and substitute the totals on a print payload.
 *
 * Non-payment tickets (kitchen order slips) carry no totals and pass
 * through untouched.
 */
export async function enforceAuthoritativePaymentTotals(
  payload: any,
  settings: any,
  source: 'ipc' | 'lan',
): Promise<EnforceTotalsResult> {
  if (!isPayment(payload)) {
    return { payload, validation: null, mismatch: null };
  }

  const meta = (payload?.meta as Record<string, any>) || {};
  const validation = validatePaymentTotals(payload?.items, meta, {
    vatEnabled: resolveVatEnabledFromMeta(meta as any, settings),
    defaultVatRate: Number((settings as any)?.defaultVatRate ?? 0),
    serviceCharge: (settings as any)?.preferences?.serviceCharge ?? null,
  });

  const next = {
    ...payload,
    meta: applyAuthoritativeTotals(meta, validation),
  };

  if (!validation.ok && validation.mismatch) {
    await recordMismatch(next, validation, source);
  }

  return { payload: next, validation, mismatch: validation.mismatch };
}
