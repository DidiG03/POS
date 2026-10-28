/**
 * The bill side of a void, for the till (`tickets:voidItem/voidTicket`) and
 * phones (`POST /tickets/void-item|void-ticket`).
 *
 * Both routes used to read the latest bill, change it in memory and write
 * it back in place, outside the table lock. A Send landing in between wrote
 * a new bill without the void (the guest was charged for it), two voids at
 * once lost one, and a void whose response was lost was applied again on
 * retry — to the next identical line, so two waters came off for one.
 *
 * Now the void runs under the table lock, is recorded as a new version of
 * the bill (so a Send built before it is recognised as stale, see
 * `recordTicketSend`), and carries the caller's idempotency key so a retry
 * changes nothing.
 */
import { prisma } from '@db/client';
import { planItemVoid, planTicketVoid } from '@shared/voidPaid';
import type { VoidTargetLine } from '@shared/voidLine';
import { withTableLock } from './core';
import { applyTableOpenState } from './tableOpen';
import { findLatestTicketLogForCurrentSession } from './tableSession';
import { restoreDailyStockForLines } from './menuStock';
import { storePlanBlocksTables } from './license';

/**
 * Kitchen stock taken at Send goes back when a sent line is voided before
 * it is paid. Store tills keep their own on-hand restock (corrections).
 */
async function restoreStockForVoided(lines: any[]): Promise<void> {
  if (storePlanBlocksTables()) return;
  const sent = lines.filter(
    (l) => l && l.fired !== false && l.staged !== true && l.paid !== true,
  );
  if (!sent.length) return;
  await restoreDailyStockForLines(
    prisma,
    sent.map((l) => ({ sku: String(l.sku || ''), qty: Number(l.qty) })),
  ).catch((e) => console.warn('[void] stock restore failed', e));
}

export type ItemVoidOutcome =
  /** The line is now voided on the bill. */
  | 'ok'
  /** This void was already applied (same idempotency key). */
  | 'duplicate'
  /** The line is paid; only an admin correction can reverse it. */
  | 'paid'
  /** Nothing on the current bill matches. */
  | 'not-found';

export type TicketVoidOutcome = 'ok' | 'duplicate' | 'paid';

async function alreadyApplied(idempotencyKey: string): Promise<boolean> {
  if (!idempotencyKey) return false;
  const row = await prisma.ticketLog
    .findFirst({ where: { idempotencyKey } as any })
    .catch(() => null);
  return Boolean(row);
}

/**
 * Write `items` as the next version of `sitting`'s bill. Owner, session and
 * covers carry over: a void does not change who serves the table.
 */
async function writeVoidedVersion(
  sitting: any,
  items: unknown[],
  note: string | null,
  idempotencyKey: string,
): Promise<'written' | 'duplicate'> {
  try {
    await prisma.ticketLog.create({
      data: {
        userId: Number(sitting.userId),
        area: sitting.area,
        tableLabel: sitting.tableLabel,
        covers: sitting.covers ?? null,
        itemsJson: items as any,
        note,
        ...(sitting.sessionKey ? { sessionKey: sitting.sessionKey } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as any,
    });
    return 'written';
  } catch (e: any) {
    if (e?.code === 'P2002' && idempotencyKey) return 'duplicate';
    throw e;
  }
}

export async function voidTicketItem(input: {
  area: string;
  tableLabel: string;
  item: VoidTargetLine;
  idempotencyKey?: string | null;
  /** Filled with the line actually voided, for the audit message. */
  report?: { qty?: number; name?: string; line?: Record<string, unknown> };
}): Promise<ItemVoidOutcome> {
  const key = String(input.idempotencyKey || '').trim();
  return withTableLock(input.area, input.tableLabel, async () => {
    if (await alreadyApplied(key)) return 'duplicate' as const;
    const sitting = await findLatestTicketLogForCurrentSession(
      input.area,
      input.tableLabel,
    );
    const items = Array.isArray(sitting?.itemsJson)
      ? ([...(sitting!.itemsJson as any[])] as any[])
      : [];
    const plan = planItemVoid(items, input.item);
    if (plan.outcome === 'paid') return 'paid' as const;
    if (!sitting || plan.outcome !== 'ok') return 'not-found' as const;
    items[plan.index] = { ...items[plan.index], voided: true };
    if (input.report) {
      input.report.qty = Number(items[plan.index]?.qty) || 0;
      input.report.name = String(items[plan.index]?.name || '');
      input.report.line = { ...(sitting!.itemsJson as any[])[plan.index] };
    }
    const written = await writeVoidedVersion(
      sitting,
      items,
      (sitting as any).note ?? null,
      key,
    );
    if (written === 'duplicate') return 'duplicate' as const;
    await restoreStockForVoided([(sitting!.itemsJson as any[])[plan.index]]);
    return 'ok' as const;
  });
}

/**
 * Void every unpaid line of the current sitting and close the table, in one
 * lock so no Send can land between the void and the close.
 *
 * `beforeClose` runs inside the lock after the bill is written: work that
 * needs the sitting to still be open (the fiscal void check, KDS cards).
 */
export async function voidWholeTicket(input: {
  area: string;
  tableLabel: string;
  reason?: string | null;
  idempotencyKey?: string | null;
  beforeClose?: () => Promise<void>;
  /** Filled with the lines this void took off the bill. */
  report?: { lines?: unknown[] };
}): Promise<TicketVoidOutcome> {
  const key = String(input.idempotencyKey || '').trim();
  const reason = String(input.reason || '').trim();
  return withTableLock(input.area, input.tableLabel, async () => {
    if (await alreadyApplied(key)) return 'duplicate' as const;
    const sitting = await findLatestTicketLogForCurrentSession(
      input.area,
      input.tableLabel,
    );
    const plan = planTicketVoid((sitting?.itemsJson as any[]) || []);
    if (plan.outcome === 'paid') return 'paid' as const;
    if (sitting) {
      const marker = `VOIDED${reason ? `: ${reason}` : ''}`;
      const note = (sitting as any).note
        ? `${(sitting as any).note} | ${marker}`
        : marker;
      const written = await writeVoidedVersion(sitting, plan.items, note, key);
      if (written === 'duplicate') return 'duplicate' as const;
      // Lines this void took off the bill (were live, now voided).
      const before = Array.isArray(sitting.itemsJson)
        ? (sitting.itemsJson as any[])
        : [];
      const taken = before.filter(
        (l, i) => l?.voided !== true && (plan.items[i] as any)?.voided === true,
      );
      if (input.report) input.report.lines = taken;
      await restoreStockForVoided(taken);
    }
    if (input.beforeClose) {
      await input.beforeClose().catch(() => undefined);
    }
    await applyTableOpenState(input.area, input.tableLabel, false).catch(
      () => false,
    );
    return 'ok' as const;
  });
}
