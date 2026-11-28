/**
 * One-time scan: sales without an invoice that never reached the review
 * list.
 *
 * Before 0.2.114, an easyPos refusal tagged env:Server (the cash cap among
 * them) was read as "easyPos may have filed it": the invoice was queued and
 * resent for ever, never held for a person, and a sale taken that way stood
 * unfiled with nothing on Settings › Fiskalizimi › Reviews. This runs once
 * per till (and again when asked) and:
 *   - holds such queued invoices for review, as a refusal is held now;
 *   - gives a review entry to a payment of a fiscalised till that has no
 *     invoice codes and no fiskalizimi record at all.
 * Nothing is sent; filed sales and sales already on the list are left alone.
 */
import { prisma } from '@db/client';
import { isAnsweredRefusal } from './classify';
import {
  createReviewFiscalClaim,
  fiscalClaimKey,
  holdDeferredClaimForReviewUnlocked,
  listFiscalClaimsDeferred,
  withFiscalClaimLock,
} from './claims';
import { docIdFromKey } from './docId';
import { logIgnored } from '../logIgnored';

export const REVIEW_BACKFILL_KEY = 'fiscal:review-backfill:v1';
/** How far back to look for payments with no invoice. */
const LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;

/** easyPos refusals whose wording says what was refused. */
const REFUSAL_TEXT =
  /totali nuk mund të jetë më shumë se|nuk mund të jetë më shumë se \d|refused the (payload|invoice)/i;

/** The HTTP status of a stored send error ("→ HTTP 400 ·"), or null. */
export function storedHttpStatus(lastError: unknown): number | null {
  const m = /HTTP\s+(\d{3})/i.exec(String(lastError || ''));
  return m ? Number(m[1]) : null;
}

/** A queued invoice whose last send was refused, not lost (pure). */
export function queuedButRefused(record: {
  state?: string;
  holdReason?: string;
  lastError?: string;
}): boolean {
  if (record.state !== 'DEFERRED' || record.holdReason) return false;
  const status = storedHttpStatus(record.lastError);
  if (status != null && isAnsweredRefusal(status)) return true;
  // 0.2.113 stored the cap refusal as a server fault, without the status.
  return REFUSAL_TEXT.test(String(record.lastError || ''));
}

/**
 * Whether a payment row is a sale of a fiscalised till left with no
 * invoice: no NIVF, and its receipt says fiskalizimi was on or pending.
 */
export function paymentLacksInvoice(p: {
  fiscalNivf?: string | null;
  metaJson?: any;
}): boolean {
  if (String(p.fiscalNivf || '').trim()) return false;
  const m = p.metaJson || {};
  if (m.reprint === true) return false;
  return (
    m.fiscalEnabled === true ||
    String(m.fiscalStatus || '').toLowerCase() === 'pending' ||
    m.fiscalPending === true
  );
}

export async function backfillFiscalReviews(options?: {
  force?: boolean;
  now?: number;
}): Promise<{ held: number; added: number }> {
  const now = options?.now ?? Date.now();
  if (!options?.force) {
    const done = await prisma.syncState
      .findUnique({ where: { key: REVIEW_BACKFILL_KEY } })
      .catch(() => null);
    if (done) return { held: 0, added: 0 };
  }
  let held = 0;
  let added = 0;

  for (const { idempotencyKey, record } of await listFiscalClaimsDeferred()) {
    if (!queuedButRefused(record)) continue;
    const ok = await withFiscalClaimLock(idempotencyKey, () =>
      holdDeferredClaimForReviewUnlocked(
        idempotencyKey,
        `easyPos refused this invoice: ${record.lastError} Fix the cause in Settings › Fiskalizimi, then choose "Send again" here.`,
      ),
    ).catch(logIgnored('reviewBackfill:hold', false));
    if (ok) held += 1;
  }

  const payments: any[] = await (prisma as any).payment
    .findMany({
      where: {
        fiscalNivf: null,
        createdAt: { gte: new Date(now - LOOKBACK_MS) },
      },
      select: {
        idempotencyKey: true,
        amount: true,
        metaJson: true,
        createdAt: true,
        fiscalNivf: true,
        order: { select: { area: true, tableLabel: true } },
      },
      take: 2000,
    })
    .catch(() => []);
  for (const p of payments) {
    const key = String(p.idempotencyKey || '').trim();
    if (!key || !paymentLacksInvoice(p)) continue;
    let docId: string;
    try {
      docId = docIdFromKey(key, 'invoice');
    } catch {
      continue;
    }
    const existing = await prisma.syncState
      .findUnique({ where: { key: fiscalClaimKey(docId) } })
      .catch(() => null);
    if (existing) continue;
    const made = await createReviewFiscalClaim(docId, {
      context: {
        area: p.order?.area ?? undefined,
        tableLabel: p.order?.tableLabel ?? undefined,
        total: Number(p.amount),
        saleKey: key,
      } as any,
      createdAt: new Date(p.createdAt).toISOString(),
      reason:
        'This sale was taken with fiskalizimi on but has no invoice and no record of one being sent. Check easyPos for this docId; if it is not there, issue the invoice.',
    }).catch(logIgnored('reviewBackfill:add', false));
    if (made) added += 1;
  }

  await prisma.syncState
    .upsert({
      where: { key: REVIEW_BACKFILL_KEY },
      create: {
        key: REVIEW_BACKFILL_KEY,
        valueJson: { at: new Date(now).toISOString(), held, added } as any,
      },
      update: {
        valueJson: { at: new Date(now).toISOString(), held, added } as any,
      },
    })
    .catch(logIgnored('reviewBackfill:mark', undefined));
  if (held || added) {
    console.warn(
      `[fiscal] review backfill: ${held} refused invoice(s) held, ${added} sale(s) without an invoice added to reviews`,
    );
  }
  return { held, added };
}
