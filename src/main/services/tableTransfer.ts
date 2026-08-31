import { prisma } from '@db/client';
import { buildTransferTicketNote } from '@shared/utils/transferNote';
import {
  broadcastTableStatusChanged,
  broadcastTicketsChanged,
} from './realtime';
import { moveCoveringReservationForTableTransfer } from './reservations';

export type TransferTableInput = {
  fromArea: string;
  fromLabel: string;
  // Optional move to a different table/area
  toArea?: string | null;
  toLabel?: string | null;
  // Optional ownership transfer
  toUserId?: number | null;
  // Actor initiating the transfer (required for authorization)
  actorUserId: number;
  /** When in cloud mode, actor may not exist in local DB; pass role from session to bypass lookup */
  actorRole?: string;
  /** Dedupes double-submit / offline retries (stored on the new destination TicketLog row). */
  idempotencyKey?: string | null;
};

export type TransferTableResult = { ok: true } | { ok: false; error: string };

function norm(s: any) {
  return String(s ?? '').trim();
}

/** Keep open KDS ticket cards aligned with the table's current waiter. */
async function updateKdsSessionOwner(
  area: string,
  tableLabel: string,
  userId: number,
): Promise<void> {
  try {
    const active = await (prisma as any).kdsOrder.findFirst({
      where: { area, tableLabel, closedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    if (!active) return;
    await (prisma as any).kdsTicket.updateMany({
      where: { orderId: active.id },
      data: { userId: Number(userId) },
    });
  } catch {
    // ignore if KDS tables not migrated
  }
}

async function readOpenMap(): Promise<Record<string, boolean>> {
  const row = await prisma.syncState
    .findUnique({ where: { key: 'tables:open' } })
    .catch(() => null);
  return ((row?.valueJson as any) || {}) as Record<string, boolean>;
}

async function writeOpenMap(map: Record<string, boolean>) {
  await prisma.syncState.upsert({
    where: { key: 'tables:open' },
    create: { key: 'tables:open', valueJson: map },
    update: { valueJson: map },
  });
}

async function readOpenAtMap(): Promise<Record<string, string>> {
  const row = await prisma.syncState
    .findUnique({ where: { key: 'tables:openAt' } })
    .catch(() => null);
  return ((row?.valueJson as any) || {}) as Record<string, string>;
}

async function writeOpenAtMap(map: Record<string, string>) {
  await prisma.syncState.upsert({
    where: { key: 'tables:openAt' },
    create: { key: 'tables:openAt', valueJson: map },
    update: { valueJson: map },
  });
}

/**
 * Build a short, readable transfer tag (prepended to the existing note).
 * {@link parseTransferTag} understands these plus older quoted/legacy shapes.
 *
 *   [TRANSFER from <Area> <Label> → <Area> <Label>]
 *   [TRANSFER from … → … · now <NewWaiter>]  (table move + new owner)
 *   [TRANSFER <FromName> → <ToName>]  (owner change, same table)
 *   Multiple tags stack so waiter then table then … stay on the ticket.
 *
 * Destination for moved-out source rows:
 *   [TRANSFER moved-out → <Area> <Label>]
 *
 * {@link TRANSFERRED_OUT_TAG_PREFIX} marks every TicketLog row of the SOURCE
 * session at the moment a table is moved. Aggregation queries skip those
 * rows so revenue is not double-counted. Items and covers are preserved for audit.
 */
export const TRANSFERRED_OUT_TAG_PREFIX = '[TRANSFER moved-out';

/** Cheap substring check used by every aggregation that reads `note`. */
export function isTransferredOutNote(note: string | null | undefined): boolean {
  return String(note || '').includes(TRANSFERRED_OUT_TAG_PREFIX);
}

export type ParsedTransferTag = {
  kind: 'MOVED' | 'OWNER';
  fromUserId: number | null;
  fromUserName: string | null;
  fromArea?: string;
  fromLabel?: string;
  toUserId?: number | null;
  toUserName?: string | null;
  byUserId: number | null;
  byUserName: string | null;
};

const TRANSFER_MOVED_RE =
  /\[TRANSFER from "((?:\\.|[^"\\])*)"(?:#(\d+))?(?: \(([^)]+)\))?(?: by "((?:\\.|[^"\\])*)"(?:#(\d+))?)?\]/;
const TRANSFER_OWNER_RE =
  /\[TRANSFER owner "((?:\\.|[^"\\])*)"(?:#(\d+))?\s*(?:->|→)\s*"((?:\\.|[^"\\])*)"(?:#(\d+))?(?: by "((?:\\.|[^"\\])*)"(?:#(\d+))?)?\]/;
const TRANSFER_LEGACY_MOVED_RE =
  /\[TRANSFER\]\s+(\S+)\s+(\S+)\s+(?:->|→)\s+(\S+)\s+(\S+)(?:\s+\(owner\s*(?:->|→)\s*(.+?)\))?/;
const TRANSFER_LEGACY_OWNER_RE = /\[TRANSFER\]\s+owner\s+(?:->|→)\s+(.+)/;

function unescapeQuoted(s: string): string {
  return String(s ?? '').replace(/\\(["\\])/g, '$1');
}

/**
 * Extract structured transfer info from a ticket-log note. Handles both the
 * new structured tag (preferred) and the legacy `[TRANSFER] ...` text format
 * that older rows still carry, so admins see the full history without a
 * backfill migration.
 */
export function parseTransferTag(
  note: string | null | undefined,
): ParsedTransferTag | null {
  const s = String(note || '');
  if (!s) return null;

  const m = s.match(TRANSFER_MOVED_RE);
  if (m) {
    const tableMatch = (m[3] || '').trim();
    let fromArea: string | undefined;
    let fromLabel: string | undefined;
    if (tableMatch) {
      const idx = tableMatch.lastIndexOf(' ');
      if (idx > 0) {
        fromArea = tableMatch.slice(0, idx);
        fromLabel = tableMatch.slice(idx + 1);
      } else {
        fromArea = tableMatch;
      }
    }
    return {
      kind: 'MOVED',
      fromUserName: unescapeQuoted(m[1]),
      fromUserId: m[2] ? Number(m[2]) : null,
      fromArea,
      fromLabel,
      byUserName: m[4] ? unescapeQuoted(m[4]) : null,
      byUserId: m[5] ? Number(m[5]) : null,
    };
  }

  const o = s.match(TRANSFER_OWNER_RE);
  if (o) {
    return {
      kind: 'OWNER',
      fromUserName: unescapeQuoted(o[1]),
      fromUserId: o[2] ? Number(o[2]) : null,
      toUserName: unescapeQuoted(o[3]),
      toUserId: o[4] ? Number(o[4]) : null,
      byUserName: o[5] ? unescapeQuoted(o[5]) : null,
      byUserId: o[6] ? Number(o[6]) : null,
    };
  }

  // Short formats: [TRANSFER from Area Label] or [TRANSFER from Area Label · now Name]
  const simpleFrom = s.match(/\[TRANSFER from\s+([^\]]+)\]/);
  if (simpleFrom) {
    const inner = simpleFrom[1].trim();
    const parts = inner.split(/\s*·\s*now\s+/);
    const locStr = parts[0].trim();
    const newOwnerHint = parts[1]?.trim() ?? null;
    const fromLoc = locStr.split(/\s*(?:→|->)\s+/)[0]?.trim() || locStr;
    let fromArea: string | undefined;
    let fromLabel: string | undefined;
    const idx = fromLoc.lastIndexOf(' ');
    if (idx > 0) {
      fromArea = fromLoc.slice(0, idx);
      fromLabel = fromLoc.slice(idx + 1);
    } else {
      fromArea = fromLoc;
    }
    return {
      kind: 'MOVED',
      fromUserName: null,
      fromUserId: null,
      fromArea,
      fromLabel,
      toUserName: newOwnerHint,
      toUserId: null,
      byUserName: null,
      byUserId: null,
    };
  }

  // Owner change on same table: [TRANSFER Alice → Carol]
  const shortOwner = s.match(/\[TRANSFER\s+(.+?)\s*→\s*(.+?)\]/);
  if (shortOwner) {
    const fromN = shortOwner[1].trim();
    const toN = shortOwner[2].trim();
    if (!/^from\s+/i.test(fromN)) {
      return {
        kind: 'OWNER',
        fromUserName: fromN,
        fromUserId: null,
        toUserName: toN,
        toUserId: null,
        byUserName: null,
        byUserId: null,
      };
    }
  }

  // Legacy formats — pre-structured tag rows.
  const lm = s.match(TRANSFER_LEGACY_MOVED_RE);
  if (lm) {
    return {
      kind: 'MOVED',
      fromUserId: null,
      fromUserName: null,
      fromArea: lm[1],
      fromLabel: lm[2],
      toUserName: lm[5] ? lm[5].trim() : null,
      toUserId: null,
      byUserId: null,
      byUserName: null,
    };
  }
  const lo = s.match(TRANSFER_LEGACY_OWNER_RE);
  if (lo) {
    return {
      kind: 'OWNER',
      fromUserId: null,
      fromUserName: null,
      toUserName: lo[1].trim(),
      toUserId: null,
      byUserId: null,
      byUserName: null,
    };
  }

  // Legacy free-text move: `[TRANSFER] Main Hall T4 -> Main Hall T6` — the
  // strict `\S+ \S+` pattern misses multi-word areas (e.g. "Main Hall").
  const transferLine =
    s.split('\n').find((line) => /\[\s*TRANSFER\s*\]/i.test(line)) || s;
  const looseMoved = transferLine.match(
    /\[TRANSFER\]\s*(.+?)\s*(?:->|→)\s*(.+)/i,
  );
  if (looseMoved) {
    let rightRaw = looseMoved[2].trim();
    let toUserNameExtra: string | null = null;
    const ownerParen = rightRaw.match(
      /^(.+?)\s*\(\s*owner\s*(?:->|→)\s*(.+?)\s*\)\s*$/i,
    );
    if (ownerParen) {
      rightRaw = ownerParen[1].trim();
      toUserNameExtra = ownerParen[2].trim();
    }
    const splitTail = (blob: string) => {
      const b = blob.trim();
      const i = b.lastIndexOf(' ');
      if (i <= 0) return { area: b, label: '' };
      return { area: b.slice(0, i).trim(), label: b.slice(i + 1).trim() };
    };
    const from = splitTail(looseMoved[1]);
    return {
      kind: 'MOVED',
      fromUserId: null,
      fromUserName: null,
      fromArea: from.area,
      fromLabel: from.label,
      toUserId: null,
      toUserName: toUserNameExtra,
      byUserId: null,
      byUserName: null,
    };
  }

  return null;
}

export async function transferTableLocal(
  input: TransferTableInput,
): Promise<TransferTableResult> {
  const fromArea = norm(input.fromArea);
  const fromLabel = norm(input.fromLabel);
  const toArea = norm(input.toArea || fromArea);
  const toLabel = norm(input.toLabel || fromLabel);
  const actorUserId = Number(input.actorUserId || 0);
  const toUserId = input.toUserId == null ? null : Number(input.toUserId || 0);

  if (!fromArea || !fromLabel)
    return { ok: false, error: 'Missing from table' };
  if (!actorUserId) return { ok: false, error: 'Missing actor' };
  if (!toArea || !toLabel)
    return { ok: false, error: 'Missing destination table' };
  if (toUserId != null && !toUserId)
    return { ok: false, error: 'Invalid destination user' };

  const [actor, last] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorUserId } }).catch(() => null),
    prisma.ticketLog
      .findFirst({
        where: { area: fromArea, tableLabel: fromLabel },
        orderBy: { createdAt: 'desc' },
      })
      .catch(() => null),
  ]);

  // In cloud mode, actor may not exist in local DB; use actorRole from session when provided
  const actorRoleFromSession = String(input.actorRole || '').trim();
  const effectiveActor =
    actor && actor.active !== false
      ? actor
      : actorRoleFromSession
        ? ({ role: actorRoleFromSession, active: true } as {
            role: string;
            active: boolean;
          })
        : null;

  if (!effectiveActor) return { ok: false, error: 'Actor not found' };
  if (!last)
    return { ok: false, error: 'No active ticket found for this table' };

  const currentOwnerId = Number(last.userId || 0);
  const isAdmin =
    String((effectiveActor as any).role || '').toUpperCase() === 'ADMIN';
  if (!isAdmin && Number(actorUserId) !== Number(currentOwnerId)) {
    return {
      ok: false,
      error: 'Only the table owner or an admin can transfer a table',
    };
  }

  // Validate new owner (if any). A transfer can only go to a waiter who:
  //   1. exists and is active, AND
  //   2. has an open DayShift right now.
  // Rule (2) prevents accidentally handing tables to staff who aren't in the
  // building — they'd never see the notification, and the table would get
  // stuck under their name. The check applies to admins too: even an admin
  // re-assigning a table must pick someone who's actually on shift.
  let newOwner: any = null;
  if (toUserId != null) {
    newOwner = await prisma.user
      .findUnique({ where: { id: toUserId } })
      .catch(() => null);
    if (!newOwner || newOwner.active === false)
      return { ok: false, error: 'Target waiter not found' };

    // Allow transferring to the current owner (no-op cases handled below);
    // otherwise the destination must be on an open shift.
    if (Number(toUserId) !== Number(currentOwnerId)) {
      const onShift = await prisma.dayShift
        .findFirst({
          where: { openedById: Number(toUserId), closedAt: null },
          select: { id: true },
        } as any)
        .catch(() => null);
      if (!onShift) {
        return {
          ok: false,
          error: `${newOwner.displayName || 'That waiter'} is not on shift right now`,
        };
      }
    }
  }

  const movingTable = fromArea !== toArea || fromLabel !== toLabel;
  const changingOwner =
    toUserId != null && Number(toUserId) !== Number(currentOwnerId);
  if (!movingTable && !changingOwner) return { ok: true };

  const transferIdem = String(input.idempotencyKey ?? '').trim();
  if (transferIdem) {
    const prior = await prisma.ticketLog
      .findFirst({ where: { idempotencyKey: transferIdem } as any })
      .catch(() => null);
    if (prior) return { ok: true };
  }

  // If moving table, ensure destination isn't already open
  const openMap = await readOpenMap();
  const fromKey = `${fromArea}:${fromLabel}`;
  const toKey = `${toArea}:${toLabel}`;
  if (!openMap[fromKey]) {
    // Some flows may create ticket logs without open-map; don't hard fail, but warn behavior.
    // We'll allow transfer and mark destination open.
  }
  if (movingTable && openMap[toKey])
    return {
      ok: false,
      error: `Destination table ${toArea} ${toLabel} is already open`,
    };

  // Move openAt timestamp (if any)
  const openAtMap = await readOpenAtMap();
  const fromAt = openAtMap[fromKey];

  // Resolve display names for the structured audit tag.
  const fromOwner = currentOwnerId
    ? await prisma.user
        .findUnique({ where: { id: currentOwnerId } })
        .catch(() => null)
    : null;
  const fromOwnerName = String(fromOwner?.displayName || `#${currentOwnerId}`);
  const actorName = String(
    (actor && (actor as any).displayName) ||
      (isAdmin ? 'Admin' : `#${actorUserId}`),
  );
  const newOwnerName = newOwner ? String(newOwner.displayName) : '';
  const fromLoc = `${fromArea} ${fromLabel}`.trim();
  const toLoc = `${toArea} ${toLabel}`.trim();
  const transferTag = movingTable
    ? changingOwner
      ? `[TRANSFER from ${fromLoc} → ${toLoc} · now ${newOwnerName}]`
      : `[TRANSFER from ${fromLoc} → ${toLoc}]`
    : `[TRANSFER ${fromOwnerName} → ${newOwnerName}]`;
  const nextNote = buildTransferTicketNote(transferTag, last.note);

  // Keep same waiter when only moving table; change owner only when transferring to another waiter
  const nextUserId = changingOwner ? Number(toUserId) : Number(currentOwnerId);
  let createdLog: { id: number };
  try {
    createdLog = await prisma.ticketLog.create({
      data: {
        userId: nextUserId,
        area: toArea,
        tableLabel: toLabel,
        covers: last.covers ?? null,
        itemsJson: last.itemsJson as any,
        note: nextNote,
        ...(transferIdem ? { idempotencyKey: transferIdem } : {}),
      } as any,
    });
  } catch (e: any) {
    if (e?.code === 'P2002' && transferIdem) return { ok: true };
    throw e;
  }

  // Rows that represented the ticket before this transfer (same physical
  // table after an owner handoff, or the source table after a move) must
  // carry the moved-out marker so staff lists / revenue don't attribute the
  // same sale to both waiters.
  const prependMovedOutToPriorSessionRows = async () => {
    const movedOutTag = `${TRANSFERRED_OUT_TAG_PREFIX} → ${toArea} ${toLabel}]`;
    try {
      const fromAtDate = fromAt
        ? new Date(fromAt)
        : (last as any)?.createdAt instanceof Date
          ? (last as any).createdAt
          : null;
      const sessionRows = await prisma.ticketLog.findMany({
        where: {
          area: fromArea,
          tableLabel: fromLabel,
          id: { not: createdLog.id },
          ...(fromAtDate ? { createdAt: { gte: fromAtDate } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, note: true } as any,
      });
      for (const r of sessionRows as { id: number; note: string | null }[]) {
        if (isTransferredOutNote(r.note)) continue;
        const next = r.note ? `${movedOutTag}\n${r.note}` : movedOutTag;
        await prisma.ticketLog
          .update({
            where: { id: r.id },
            data: { note: next } as any,
          })
          .catch(() => null);
      }
    } catch {
      // Best-effort: never fail the transfer because we couldn't tag the
      // source session. Aggregations will fall back to the existing
      // behavior; the destination row is the source of truth.
    }
  };

  // Update open maps
  if (movingTable) {
    // Close old key, open new key
    delete openMap[fromKey];
    openMap[toKey] = true;
    await writeOpenMap(openMap);

    // Move openAt timestamp if present, otherwise set now
    delete openAtMap[fromKey];
    openAtMap[toKey] = fromAt || new Date().toISOString();
    await writeOpenAtMap(openAtMap);

    await prependMovedOutToPriorSessionRows();

    // Mirror guest count into the `Covers` table so `covers:getLast` (used by
    // OrderPage for pay gating / UI) matches the transferred ticket log row.
    const cov = Number(last.covers);
    if (Number.isFinite(cov) && cov > 0) {
      await prisma.covers
        .create({
          data: {
            area: toArea,
            label: toLabel,
            covers: Math.min(999, Math.max(1, Math.floor(cov))),
          },
        })
        .catch(() => null);
    }

    // Move pending/approved requests to new table (keep ownership logic handled separately below)
    await prisma.ticketRequest
      .updateMany({
        where: {
          area: fromArea,
          tableLabel: fromLabel,
          status: { in: ['PENDING', 'APPROVED'] as any },
        },
        data: { area: toArea, tableLabel: toLabel },
      } as any)
      .catch(() => null);

    // Move active KDS order if present (best effort)
    try {
      const active = await (prisma as any).kdsOrder.findFirst({
        where: { area: fromArea, tableLabel: fromLabel, closedAt: null },
        orderBy: { openedAt: 'desc' },
      });
      if (active) {
        await (prisma as any).kdsOrder.update({
          where: { id: active.id },
          data: { area: toArea, tableLabel: toLabel },
        });
      }
    } catch {
      // ignore if KDS tables not migrated
    }

    await moveCoveringReservationForTableTransfer(
      fromArea,
      fromLabel,
      toArea,
      toLabel,
    );
  } else {
    // Not moving table: ensure openAt exists (no-op otherwise)
    if (!openAtMap[fromKey] && openMap[fromKey]) {
      openAtMap[fromKey] = new Date().toISOString();
      await writeOpenAtMap(openAtMap);
    }
    // Owner handoff on the same table: snapshot row is `createdLog`; prior
    // rows still have the old waiter as userId — tag them moved-out so only
    // the colleague appears in "Tickets by staff" / revenue for this sale.
    if (changingOwner) {
      await prependMovedOutToPriorSessionRows();
    }
  }

  // If changing owner, move open requests to new owner too
  if (changingOwner) {
    await prisma.ticketRequest
      .updateMany({
        where: {
          area: toArea,
          tableLabel: toLabel,
          status: { in: ['PENDING', 'APPROVED'] as any },
        },
        data: { ownerId: Number(toUserId) },
      } as any)
      .catch(() => null);

    await updateKdsSessionOwner(toArea, toLabel, nextUserId);

    const msg = movingTable
      ? `Table transferred to you: ${fromArea} ${fromLabel} → ${toArea} ${toLabel}`
      : `Table transferred to you: ${toArea} ${toLabel}`;
    await prisma.notification
      .create({
        data: {
          userId: Number(toUserId),
          type: 'OTHER' as any,
          message: msg,
        } as any,
      })
      .catch(() => null);
  }

  // Notify all admins so the transfer is auditable from the admin
  // notifications panel and matches the existing void / move workflows.
  try {
    const admins = await prisma.user
      .findMany({
        where: { role: 'ADMIN' as any, active: true },
        select: { id: true },
      } as any)
      .catch(() => [] as { id: number }[]);
    const tableLine = movingTable
      ? `${fromArea} ${fromLabel} → ${toArea} ${toLabel}`
      : `${toArea} ${toLabel}`;
    const ownerLine = changingOwner
      ? ` (waiter ${fromOwnerName} → ${newOwnerName})`
      : '';
    const adminMsg = `Ticket transferred${ownerLine ? '' : ` from ${fromOwnerName}`}: ${tableLine}${ownerLine} by ${actorName}`;
    for (const a of admins as { id: number }[]) {
      await prisma.notification
        .create({
          data: {
            userId: Number(a.id),
            type: 'OTHER' as any,
            message: adminMsg,
          } as any,
        })
        .catch(() => null);
    }
  } catch {
    // Notifications are best-effort; never block the transfer on them.
  }

  if (movingTable) {
    try {
      broadcastTableStatusChanged({
        area: fromArea,
        label: fromLabel,
        open: false,
      });
      broadcastTableStatusChanged({ area: toArea, label: toLabel, open: true });
      broadcastTicketsChanged({
        area: toArea,
        tableLabel: toLabel,
        userId: nextUserId,
      });
    } catch {
      // Best-effort — LAN tablets and other POS windows rely on these events.
    }
  } else if (changingOwner) {
    try {
      broadcastTicketsChanged({
        area: toArea,
        tableLabel: toLabel,
        userId: nextUserId,
      });
    } catch {
      // ignore
    }
  }

  return { ok: true };
}
