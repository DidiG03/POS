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
 * Line prices and VAT rates are checked against this host's menu first
 * (`linePricing.ts`), so the lines — which the receipt, the sales ledger
 * and the fiscal invoice are built from — are not the client's word
 * either.
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
import {
  describeLineIssues,
  repriceLinesFromMenu,
  type LinePriceIssue,
} from './linePricing';

export interface EnforceTotalsResult {
  /**
   * Payload with line prices taken from the menu and `meta` totals
   * replaced by host-computed values.
   */
  payload: any;
  /** `null` when the ticket is not a payment. */
  validation: TotalsValidation | null;
  /** Divergence summary, `null` when the client agreed with us. */
  mismatch: string | null;
  /** Lines that were repriced, dropped or not found on the menu. */
  lineIssues: LinePriceIssue[];
}

function isPayment(payload: any): boolean {
  return String(payload?.meta?.kind || '').toUpperCase() === 'PAYMENT';
}

/** A Reports reprint shows a past sale as it was — never repriced. */
function isReprint(payload: any): boolean {
  return payload?.meta?.reprint === true;
}

const MENU_UNAVAILABLE =
  'line prices could not be checked against the menu (menu unavailable)';

/**
 * Persist a tampering/drift signal for every admin plus the acting
 * waiter. Best-effort: an audit write must never stop a payment.
 */
async function recordMismatch(
  payload: any,
  validation: TotalsValidation,
  detail: string,
  source: string,
): Promise<void> {
  const area = String(payload?.area || '');
  const tableLabel = String(payload?.tableLabel || '');
  const who = String(payload?.userName || '').trim();
  const message =
    `Payment check on ${area} Table ${tableLabel}` +
    `${who ? ` (${who})` : ''}: ${detail}. ` +
    `Charged ${validation.computed.totalDue.toFixed(2)}. ` +
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
    return { payload, validation: null, mismatch: null, lineIssues: [] };
  }

  const meta = (payload?.meta as Record<string, any>) || {};

  let items = payload?.items;
  let lineIssues: LinePriceIssue[] = [];
  let lineDetail: string | null = null;
  if (!isReprint(payload)) {
    const repriced = await repriceLinesFromMenu({
      items,
      area: String(payload?.area || ''),
      tableLabel: String(payload?.tableLabel || ''),
    });
    if (repriced) {
      items = repriced.items;
      lineIssues = repriced.issues;
      lineDetail = describeLineIssues(lineIssues);
    } else {
      lineDetail = MENU_UNAVAILABLE;
    }
  }

  const validation = validatePaymentTotals(items, meta, {
    vatEnabled: resolveVatEnabledFromMeta(meta as any, settings),
    defaultVatRate: Number((settings as any)?.defaultVatRate ?? 0),
    serviceCharge: (settings as any)?.preferences?.serviceCharge ?? null,
  });

  const nextMeta: Record<string, any> = applyAuthoritativeTotals(
    meta,
    validation,
  );
  if (lineDetail) {
    nextMeta.linePriceCheck = {
      detail: lineDetail,
      issues: lineIssues,
      at: new Date().toISOString(),
    };
  }
  const next = { ...payload, items, meta: nextMeta };

  const mismatch =
    [lineDetail, validation.mismatch].filter(Boolean).join('; ') || null;
  if (mismatch) {
    await recordMismatch(next, validation, mismatch, source);
  }

  return { payload: next, validation, mismatch, lineIssues };
}
