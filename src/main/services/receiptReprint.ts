/**
 * Printing a receipt again, and what a device may say about tax codes.
 *
 * A reprint (`meta.reprint`, the Reports screen's "Print ticket" on a paid
 * sale) skipped every payment check: no repricing, no table, no filing.
 * The till printed whatever the phone sent, tax codes included, so a phone
 * could print a "fiscally registered" receipt with a made-up NIVF and QR
 * for items never sold, at any price. Now:
 *   - a reprint names the sale it reprints (`meta.reprintOf`, its order
 *     id), and the till prints its own stored receipt of that sale, codes
 *     from its own records; anything else in the request is ignored, and
 *     a reprint naming no recorded sale is refused;
 *   - tax codes in any other request are removed: the till adds them only
 *     when it files the invoice itself (`fiscal/index.ts`).
 */
import { prisma } from '@db/client';
import { isPaymentReprint } from './paymentSettle';

/** Fields only the till may put on a receipt. */
export const TILL_FISCAL_FIELDS = [
  'fiscalEnabled',
  'fiscalStatus',
  'fiscalNivf',
  'fiscalNslf',
  'fiscalEic',
  'fiscalLink',
  'fiscalQrCode',
  'fiscalTin',
  'fiscalDoc',
  'fiscalWarning',
  'fiscalTotalLek',
  'fiscalFiledLateAt',
] as const;

/** `meta` without the tax fields a device must not set. */
export function stripClientFiscalMeta<T extends Record<string, unknown>>(
  meta: T | null | undefined,
): T | undefined {
  if (!meta || typeof meta !== 'object') return meta ?? undefined;
  const out: Record<string, unknown> = { ...meta };
  for (const k of TILL_FISCAL_FIELDS) delete out[k];
  return out as T;
}

export const REPRINT_NOT_FOUND = 'REPRINT_NOT_FOUND';

function text(v: unknown): string {
  return String(v ?? '').trim();
}

export type StoredReceipt =
  | { ok: true; payload: Record<string, any>; meta: Record<string, unknown> }
  | { ok: false; error: 'not-found' | 'no-receipt' };

/**
 * The receipt the till printed for a sale, with the tax codes it holds for
 * it, marked as a reprint (never a sale, never filed again).
 */
export async function storedReceiptForSale(
  orderId: number,
): Promise<StoredReceipt> {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0)
    return { ok: false, error: 'not-found' };
  const order: any = await prisma.order
    .findUnique({
      where: { id },
      include: { payments: { orderBy: { id: 'desc' }, take: 1 } },
    } as any)
    .catch(() => null);
  if (!order) return { ok: false, error: 'not-found' };
  const payment = Array.isArray(order.payments) ? order.payments[0] : null;
  const key = text(payment?.idempotencyKey);
  if (!key) return { ok: false, error: 'no-receipt' };
  const job: any = await prisma.printJob
    .findUnique({ where: { idempotencyKey: key } } as any)
    .catch(() => null);
  const payload = job?.payloadJson;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'no-receipt' };
  }
  const paymentMeta =
    payment?.metaJson && typeof payment.metaJson === 'object'
      ? payment.metaJson
      : {};
  const meta: Record<string, unknown> = { ...(payload.meta || {}) };
  // The payment row is stamped too (a late filing); fill what the receipt lacks.
  const fill = (k: string, v: unknown) => {
    if (!text(meta[k]) && text(v)) meta[k] = text(v);
  };
  fill('fiscalNivf', payment?.fiscalNivf);
  fill('fiscalNslf', payment?.fiscalNslf);
  fill('fiscalEic', payment?.fiscalEic);
  fill('fiscalLink', paymentMeta.fiscalLink);
  fill('fiscalQrCode', paymentMeta.fiscalQrCode);
  fill('fiscalTin', paymentMeta.fiscalTin);
  if (text(meta.fiscalNivf)) {
    meta.fiscalEnabled = true;
    meta.fiscalStatus = 'accepted';
    delete meta.fiscalWarning;
  }
  meta.kind = 'PAYMENT';
  meta.reprint = true;
  meta.closeTable = false;
  return { ok: true, payload, meta };
}

export type DeviceReprint =
  | { kind: 'not-reprint' }
  | { kind: 'print'; payload: Record<string, any> }
  | { kind: 'refuse'; code: string; error: string };

/**
 * What a reprint request from a device prints: the stored receipt of the
 * sale it names, with who asked for it, or a refusal.
 */
export async function resolveDeviceReprint(request: {
  meta?: unknown;
  userName?: unknown;
}): Promise<DeviceReprint> {
  if (!isPaymentReprint(request.meta)) return { kind: 'not-reprint' };
  const orderId = Number((request.meta as any)?.reprintOf);
  const stored = await storedReceiptForSale(orderId);
  if (!stored.ok) {
    return {
      kind: 'refuse',
      code: REPRINT_NOT_FOUND,
      error:
        'The till has no receipt for this sale, so nothing was printed. Refresh Reports and try again.',
    };
  }
  return {
    kind: 'print',
    payload: {
      ...stored.payload,
      meta: stored.meta,
    },
  };
}
