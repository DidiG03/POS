/**
 * A kitchen slip asked for again is printed as a copy.
 *
 * The print route deduplicates one request by its idempotency key, but the
 * same order posted again with a new key printed a second, fresh-looking
 * slip and the kitchen cooked it twice. The app never does that; a script or
 * a replaying device can. A repeat is now printed with "REPRINT - sent
 * HH:MM" (`print.ts` banner) instead of refused, so a deliberate re-send
 * still reaches the kitchen.
 *
 * A repeat is the same Send (`meta.sendKey`, set by the app) printed before
 * at this table, or — for callers without a Send key — the same lines at
 * the same table within {@link KEYLESS_REPEAT_WINDOW_MS}.
 */
import { prisma } from '@db/client';

export const KEYLESS_REPEAT_WINDOW_MS = 10 * 60_000;
const LOOKBACK_MS = 13 * 60 * 60_000;

/** Lines of a slip, order-independent. */
export function slipFingerprint(items: unknown): string {
  const lines = (Array.isArray(items) ? items : []).map((it: any) =>
    [
      String(it?.sku || it?.name || '').trim(),
      String(it?.name || '').trim(),
      String(Number(it?.qty) || 1),
      String(it?.note || '').trim(),
    ].join('~'),
  );
  return lines.sort().join('|');
}

/** Pure core: the earlier print this slip repeats, if any. */
export function findRepeatedSlip(
  payload: any,
  earlier: Array<{ createdAt: Date; payloadJson: any }>,
  now = Date.now(),
): Date | null {
  const meta = payload?.meta || {};
  const area = String(payload?.area || '');
  const table = String(payload?.tableLabel || '');
  const sendKey = String(meta.sendKey || '').trim();
  const fp = slipFingerprint(payload?.items);
  for (const row of earlier) {
    const p = row.payloadJson || {};
    const m = p.meta || {};
    if (String(m.kind || '').toUpperCase() !== 'ORDER') continue;
    if (m.voidSlip || m.reprintOfIso) continue;
    if (String(p.area || '') !== area || String(p.tableLabel || '') !== table)
      continue;
    if (sendKey) {
      if (String(m.sendKey || '').trim() === sendKey) return row.createdAt;
      continue;
    }
    const age = now - new Date(row.createdAt).getTime();
    if (age <= KEYLESS_REPEAT_WINDOW_MS && slipFingerprint(p.items) === fp) {
      return row.createdAt;
    }
  }
  return null;
}

/**
 * Mark `payload` (in place) as a copy when it repeats a slip already sent
 * to the kitchen. Only kitchen ORDER slips; voids and reprints are left
 * alone.
 */
export async function markRepeatedKitchenSlip(payload: any): Promise<void> {
  const meta = payload?.meta;
  if (!meta || String(meta.kind || '').toUpperCase() !== 'ORDER') return;
  if (meta.voidSlip || meta.reprintOfIso) return;
  const rows = (await prisma.printJob
    .findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - LOOKBACK_MS) },
        printerProfileId: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { createdAt: true, payloadJson: true },
    } as any)
    .catch(() => [])) as Array<{ createdAt: Date; payloadJson: any }>;
  const first = findRepeatedSlip(payload, rows);
  if (first) meta.reprintOfIso = new Date(first).toISOString();
}
