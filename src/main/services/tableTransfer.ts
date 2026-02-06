import { prisma } from '@db/client';

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
};

export type TransferTableResult = { ok: true } | { ok: false; error: string };

function norm(s: any) {
  return String(s ?? '').trim();
}

async function readOpenMap(): Promise<Record<string, boolean>> {
  const row = await prisma.syncState.findUnique({ where: { key: 'tables:open' } }).catch(() => null);
  return ((row?.valueJson as any) || {}) as Record<string, boolean>;
}

async function writeOpenMap(map: Record<string, boolean>) {
  await prisma.syncState.upsert({ where: { key: 'tables:open' }, create: { key: 'tables:open', valueJson: map }, update: { valueJson: map } });
}

async function readOpenAtMap(): Promise<Record<string, string>> {
  const row = await prisma.syncState.findUnique({ where: { key: 'tables:openAt' } }).catch(() => null);
  return ((row?.valueJson as any) || {}) as Record<string, string>;
}

async function writeOpenAtMap(map: Record<string, string>) {
  await prisma.syncState.upsert({ where: { key: 'tables:openAt' }, create: { key: 'tables:openAt', valueJson: map }, update: { valueJson: map } });
}

export async function transferTableLocal(input: TransferTableInput): Promise<TransferTableResult> {
  const fromArea = norm(input.fromArea);
  const fromLabel = norm(input.fromLabel);
  const toArea = norm(input.toArea || fromArea);
  const toLabel = norm(input.toLabel || fromLabel);
  const actorUserId = Number(input.actorUserId || 0);
  const toUserId = input.toUserId == null ? null : Number(input.toUserId || 0);

  if (!fromArea || !fromLabel) return { ok: false, error: 'Missing from table' };
  if (!actorUserId) return { ok: false, error: 'Missing actor' };
  if (!toArea || !toLabel) return { ok: false, error: 'Missing destination table' };
  if (toUserId != null && !toUserId) return { ok: false, error: 'Invalid destination user' };

  const [actor, last] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorUserId } }).catch(() => null),
    prisma.ticketLog.findFirst({ where: { area: fromArea, tableLabel: fromLabel }, orderBy: { createdAt: 'desc' } }).catch(() => null),
  ]);

  if (!actor || actor.active === false) return { ok: false, error: 'Actor not found' };
  if (!last) return { ok: false, error: 'No active ticket found for this table' };

  const currentOwnerId = Number(last.userId || 0);
  const isAdmin = String((actor as any).role || '').toUpperCase() === 'ADMIN';
  if (!isAdmin && Number(actorUserId) !== Number(currentOwnerId)) {
    return { ok: false, error: 'Only the table owner or an admin can transfer a table' };
  }

  // Validate new owner (if any)
  let newOwner: any = null;
  if (toUserId != null) {
    newOwner = await prisma.user.findUnique({ where: { id: toUserId } }).catch(() => null);
    if (!newOwner || newOwner.active === false) return { ok: false, error: 'Target waiter not found' };
  }

  const movingTable = fromArea !== toArea || fromLabel !== toLabel;
  const changingOwner = toUserId != null && Number(toUserId) !== Number(currentOwnerId);
  if (!movingTable && !changingOwner) return { ok: true };

  // If moving table, ensure destination isn't already open
  const openMap = await readOpenMap();
  const fromKey = `${fromArea}:${fromLabel}`;
  const toKey = `${toArea}:${toLabel}`;
  if (!openMap[fromKey]) {
    // Some flows may create ticket logs without open-map; don't hard fail, but warn behavior.
    // We'll allow transfer and mark destination open.
  }
  if (movingTable && openMap[toKey]) return { ok: false, error: `Destination table ${toArea} ${toLabel} is already open` };

  // Move openAt timestamp (if any)
  const openAtMap = await readOpenAtMap();
  const fromAt = openAtMap[fromKey];

  // Create a new ticket snapshot that represents the transferred state
  const note = String(last.note || '');
  const transferTag = movingTable
    ? `[TRANSFER] ${fromArea} ${fromLabel} → ${toArea} ${toLabel}${changingOwner ? ` (owner → ${newOwner?.displayName || toUserId})` : ''}`
    : `[TRANSFER] owner → ${newOwner?.displayName || toUserId}`;
  const nextNote = note ? `${note}\n${transferTag}` : transferTag;

  const nextUserId = changingOwner ? Number(toUserId) : Number(currentOwnerId);
  await prisma.ticketLog.create({
    data: {
      userId: nextUserId,
      area: toArea,
      tableLabel: toLabel,
      covers: last.covers ?? null,
      itemsJson: last.itemsJson as any,
      note: nextNote,
    } as any,
  });

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

    // Move pending/approved requests to new table (keep ownership logic handled separately below)
    await prisma.ticketRequest
      .updateMany({
        where: { area: fromArea, tableLabel: fromLabel, status: { in: ['PENDING', 'APPROVED'] as any } },
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
        await (prisma as any).kdsOrder.update({ where: { id: active.id }, data: { area: toArea, tableLabel: toLabel } });
      }
    } catch {
      // ignore if KDS tables not migrated
    }
  } else {
    // Not moving table: ensure openAt exists (no-op otherwise)
    if (!openAtMap[fromKey] && openMap[fromKey]) {
      openAtMap[fromKey] = new Date().toISOString();
      await writeOpenAtMap(openAtMap);
    }
  }

  // If changing owner, move open requests to new owner too
  if (changingOwner) {
    await prisma.ticketRequest
      .updateMany({
        where: { area: toArea, tableLabel: toLabel, status: { in: ['PENDING', 'APPROVED'] as any } },
        data: { ownerId: Number(toUserId) },
      } as any)
      .catch(() => null);

    const msg = movingTable
      ? `Table transferred to you: ${fromArea} ${fromLabel} → ${toArea} ${toLabel}`
      : `Table transferred to you: ${toArea} ${toLabel}`;
    await prisma.notification.create({ data: { userId: Number(toUserId), type: 'OTHER' as any, message: msg } as any }).catch(() => null);
  }

  return { ok: true };
}

