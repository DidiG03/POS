import { shouldKeepLocalDraftOnEmptyLog } from '@shared/ticketDraft';
import { asTicketLogItems } from '@shared/ticketLogItems';
import { peekFloorSnapshot, peekLatestTicket } from './posReadCache';
import {
  cacheLooksLikeCurrentSession,
  cachedTicketHasLines,
} from './tableSessionKeepOpen';
import type { TicketRead, TicketReadItems } from './ticketRead';

export type TableBillPeek = {
  items: TicketReadItems;
  note: string;
};

export type HostBillDecision =
  | { kind: 'unreadable' }
  | { kind: 'hydrate'; items: TicketReadItems; note: string }
  | { kind: 'keep' }
  | { kind: 'voided'; items: TicketReadItems; note: string }
  | { kind: 'empty'; note: string };

function noteOf(value: { note?: unknown } | null | undefined): string {
  return typeof value?.note === 'string' ? value.note : '';
}

/** Last-known lines from the floor snapshot or ticket cache. Never `[]`. */
export function peekTableBill(
  area: string,
  label: string,
): TableBillPeek | null {
  const snap = peekFloorSnapshot(area);
  const snapRow = snap?.tables?.find(
    (row) => row.area === area && row.label === label,
  );
  if (snap && Array.isArray(snap.tables) && !snapRow) {
    return null;
  }
  if (snapRow && cachedTicketHasLines(snapRow)) {
    const items = asTicketLogItems(snapRow.items) as TicketReadItems;
    return {
      items,
      note: noteOf(snapRow),
    };
  }
  const cached = peekLatestTicket(area, label);
  if (!cachedTicketHasLines(cached)) {
    return null;
  }
  const openedAt = snapRow?.openedAt;
  if (openedAt && !cacheLooksLikeCurrentSession(cached, openedAt)) {
    return null;
  }
  const items = asTicketLogItems(cached.items) as TicketReadItems;
  return {
    items,
    note: noteOf(cached),
  };
}

export function hostBillHasLiveLines(items: TicketReadItems): boolean {
  return items.some((it) => it && it.voided !== true);
}

/**
 * The sitting's running total as the floor last painted it, or `null` when the
 * floor has nothing to say about this table.
 *
 * The floor derives this from the same occupancy-bounded TicketLog row the
 * ticket read asks for, so a positive total here is independent evidence that
 * the sitting has a bill — even when the read hands back nothing.
 */
export function peekTableBillTotal(area: string, label: string): number | null {
  const snap = peekFloorSnapshot(area);
  const row = snap?.tables?.find((r) => r.area === area && r.label === label);
  if (!row) return null;
  const total = Number((row as { total?: unknown }).total);
  return Number.isFinite(total) ? total : null;
}

/**
 * How to apply a host bill read to the open table the waiter is looking at.
 * `keep` means do not paint an empty cart — the sitting is still live.
 */
export function decideHostBill(opts: {
  read: TicketRead;
  currentLines: Array<{ voided?: boolean }>;
  hasCovers: boolean;
  suppressClose: boolean;
  withinPostSendGrace: boolean;
  /** {@link peekTableBillTotal} — the floor's running total for this sitting. */
  expectedTotal?: number | null;
}): HostBillDecision {
  if (!opts.read.ok) {
    return { kind: 'unreadable' };
  }
  const items = opts.read.items;
  if (hostBillHasLiveLines(items)) {
    // Right after Send the host bill matches what we just unstaged locally.
    // Hydrating in that window re-merges staged copies and briefly doubles
    // every line on the ticket until the waiter leaves and comes back.
    if (
      opts.withinPostSendGrace &&
      opts.currentLines.some((l) => l.voided !== true)
    ) {
      return { kind: 'keep' };
    }
    return { kind: 'hydrate', items, note: opts.read.note };
  }
  if (items.length > 0) {
    return { kind: 'voided', items, note: opts.read.note };
  }
  if (opts.withinPostSendGrace) {
    return { kind: 'keep' };
  }
  if (opts.suppressClose) {
    return { kind: 'keep' };
  }
  if (shouldKeepLocalDraftOnEmptyLog(opts.currentLines)) {
    return { kind: 'keep' };
  }
  // Nothing came back, yet the floor is painting money on this table. Treating
  // that as an empty bill is how a waiter ends up staring at a blank ticket on
  // an occupied table — and the next send would then rewrite the check down to
  // just the new items. A read we can prove is incomplete is unreadable.
  if (Number(opts.expectedTotal || 0) > 0) {
    return { kind: 'unreadable' };
  }
  if (opts.hasCovers) {
    return { kind: 'keep' };
  }
  return { kind: 'empty', note: opts.read.note };
}
