import { prisma } from '@db/client';
import {
  latestRowPerSession,
  sumTicketLinesNetVat,
} from '@shared/ticketRevenue';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import { coreServices } from './core';
import { mapOrderToFiscalSaleRow } from './saleCorrection';
import { isTransferredOutNote, parseTransferTag } from './tableTransfer';

export async function listAdminTicketCounts(input?: {
  startIso?: string;
  endIso?: string;
}) {
  const where: any = {};
  if (input?.startIso || input?.endIso) {
    where.createdAt = {};
    if (input?.startIso) where.createdAt.gte = new Date(input.startIso);
    if (input?.endIso) where.createdAt.lte = new Date(input.endIso);
  }
  // Per-user ticket counts: only the rows that still represent live
  // revenue. Rows whose session was moved to another table carry the
  // `[TRANSFER moved-out ...]` tag and would otherwise inflate the
  // count by 2x (source + destination).
  const liveTicketsWhere = {
    ...where,
    NOT: { note: { contains: '[TRANSFER moved-out' } },
  } as any;
  const logs = await prisma.ticketLog
    .groupBy({
      where: liveTicketsWhere,
      by: ['userId'],
      _count: { userId: true },
    } as any)
    .catch(() => []);
  const users = await prisma.user.findMany({
    where: { role: { not: 'ADMIN' } } as any,
  });

  let clockedInDuringPeriod: Set<number> | null = null;
  if (input?.startIso || input?.endIso) {
    const rangeStart = input?.startIso ? new Date(input.startIso) : new Date(0);
    const rangeEnd = input?.endIso ? new Date(input.endIso) : new Date();
    const periodShifts = await prisma.dayShift
      .findMany({
        where: {
          OR: [
            { closedAt: null, openedAt: { lte: rangeEnd } },
            {
              openedAt: { lte: rangeEnd },
              closedAt: { gte: rangeStart },
            },
          ],
        },
        select: { openedById: true },
      } as any)
      .catch(() => [] as { openedById: number }[]);
    clockedInDuringPeriod = new Set(
      (periodShifts as { openedById: number }[]).map((s) =>
        Number(s.openedById),
      ),
    );
  }

  const openShifts = await prisma.dayShift.findMany({
    where: { closedAt: null },
  });
  const openIds = new Set(openShifts.map((s: any) => s.openedById));
  const counts: Record<number, number> = {};
  for (const r of logs as any[]) counts[r.userId] = r._count.userId;

  const transfersIn: Record<number, number> = {};
  try {
    const transferRows = await prisma.ticketLog
      .findMany({
        where: { ...where, note: { contains: '[TRANSFER' } },
        select: { userId: true, note: true },
      } as any)
      .catch(() => [] as { userId: number; note: string | null }[]);
    for (const row of transferRows as {
      userId: number;
      note: string | null;
    }[]) {
      if (isTransferredOutNote(row.note)) continue;
      transfersIn[row.userId] = (transfersIn[row.userId] ?? 0) + 1;
    }
  } catch {
    // Best-effort metric — never block the list on it.
  }

  const visibleUsers =
    clockedInDuringPeriod == null
      ? users
      : users.filter((u: any) => clockedInDuringPeriod!.has(u.id));

  return visibleUsers.map((u: any) => ({
    id: u.id,
    name: u.displayName,
    active: openIds.has(u.id),
    tickets: counts[u.id] ?? 0,
    transfersIn: transfersIn[u.id] ?? 0,
  }));
}

export async function listAdminTicketsByUser(input?: {
  userId?: number;
  startIso?: string;
  endIso?: string;
  limit?: number;
}) {
  const userId = Number(input?.userId);
  if (!userId) return [];
  const settings = await coreServices.readSettings().catch(() => ({}));
  const defaultVatEnabled = isVatEnabledFromSettings(settings);
  const fiscalTin = String((settings as any)?.fiscal?.nipt || '').trim();
  const where: any = { userId };
  if (input?.startIso || input?.endIso) {
    where.createdAt = {};
    if (input?.startIso) where.createdAt.gte = new Date(input.startIso);
    if (input?.endIso) where.createdAt.lte = new Date(input.endIso);
  }
  const limit = Math.min(2000, Math.max(1, Number(input?.limit || 500)));
  const rows = await prisma.ticketLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const visibleRows = latestRowPerSession(
    (rows as any[]).filter((r: any) => !isTransferredOutNote(r?.note)),
  );

  const uniqueTables = Array.from(
    new Set(
      (visibleRows as any[]).map((r: any) => `${r.area}|${r.tableLabel}`),
    ),
  );
  const openMap: Record<string, boolean> = {};
  for (const t of await coreServices.listOpenTables().catch(() => [])) {
    openMap[`${t.area}:${t.label}`] = true;
  }

  const paymentsByTable = new Map<
    string,
    {
      atMs: number;
      vatEnabled: boolean;
      sale: ReturnType<typeof mapOrderToFiscalSaleRow>;
    }[]
  >();
  if (uniqueTables.length) {
    const tableFilters = uniqueTables
      .map((k) => {
        const [area, tableLabel] = String(k).split('|');
        if (!area || !tableLabel) return null;
        return { area, tableLabel };
      })
      .filter(Boolean) as { area: string; tableLabel: string }[];
    const earliestClosedFrom = (visibleRows as any[]).reduce(
      (min: number, r: any) => {
        const ms = new Date(r.createdAt).getTime();
        return Number.isFinite(ms) && ms < min ? ms : min;
      },
      Number.POSITIVE_INFINITY,
    );
    const sales = tableFilters.length
      ? await prisma.order
          .findMany({
            where: {
              status: { in: ['PAID', 'VOID'] } as any,
              OR: tableFilters,
              ...(Number.isFinite(earliestClosedFrom)
                ? { closedAt: { gte: new Date(earliestClosedFrom) } }
                : {}),
            } as any,
            include: {
              items: { orderBy: { sortOrder: 'asc' } },
              payments: { orderBy: { createdAt: 'desc' }, take: 1 },
              corrections: { orderBy: { createdAt: 'desc' } },
            } as any,
          })
          .catch(() => [])
      : [];
    for (const sale of sales as any[]) {
      const k = `${String(sale.area || '')}|${String(sale.tableLabel || '')}`;
      if (!uniqueTables.includes(k)) continue;
      const at = sale.closedAt ? new Date(sale.closedAt as any).getTime() : NaN;
      if (!Number.isFinite(at)) continue;
      const arr = paymentsByTable.get(k) || [];
      arr.push({
        atMs: at,
        vatEnabled: Boolean(sale.vatEnabled),
        sale: mapOrderToFiscalSaleRow(sale, { tin: fiscalTin }),
      });
      paymentsByTable.set(k, arr);
    }
    for (const [, arr] of paymentsByTable) arr.sort((a, b) => a.atMs - b.atMs);
  }

  const usedOrderIds = new Set<number>();
  const saleByLogId = new Map<
    number,
    { vatEnabled: boolean; sale: ReturnType<typeof mapOrderToFiscalSaleRow> }
  >();
  const chronological = [...(visibleRows as any[])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  for (const r of chronological) {
    const tKey = `${r.area}|${r.tableLabel}`;
    const rowMs = new Date(r.createdAt).getTime();
    const covering = (paymentsByTable.get(tKey) || []).find(
      (p) => p.atMs >= rowMs && !usedOrderIds.has(p.sale.orderId),
    );
    if (!covering) continue;
    usedOrderIds.add(covering.sale.orderId);
    saleByLogId.set(Number(r.id), covering);
  }

  return visibleRows.map((r: any) => {
    const items = Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [];
    const liveItems = items.filter((it: any) => !it?.voided);
    const noteStr = String(r.note || '').toUpperCase();
    const allVoided =
      items.length > 0 && items.every((it: any) => it?.voided === true);
    const covering = saleByLogId.get(Number(r.id));
    const saleVoided =
      String(covering?.sale.status || '').toUpperCase() === 'VOID';
    const isVoided = allVoided || /\bVOIDED\b/.test(noteStr) || saleVoided;
    const isTransferredOut = isTransferredOutNote(r.note);

    const isPaid = Boolean(covering);
    const rowVatEnabled = covering ? covering.vatEnabled : defaultVatEnabled;
    const isOpen = Boolean(openMap[`${r.area}:${r.tableLabel}`]);

    const status: 'PAID' | 'VOIDED' | 'ACTIVE' | 'TRANSFERRED' = isVoided
      ? 'VOIDED'
      : isTransferredOut
        ? 'TRANSFERRED'
        : isPaid
          ? 'PAID'
          : isOpen
            ? 'ACTIVE'
            : 'PAID';

    const parsedTransfer = parseTransferTag(r.note);
    const transfer = parsedTransfer
      ? {
          kind: parsedTransfer.kind,
          fromUserId: parsedTransfer.fromUserId,
          fromUserName: parsedTransfer.fromUserName,
          fromArea: parsedTransfer.fromArea ?? null,
          fromLabel: parsedTransfer.fromLabel ?? null,
          toUserId: parsedTransfer.toUserId ?? null,
          toUserName: parsedTransfer.toUserName ?? null,
          byUserId: parsedTransfer.byUserId,
          byUserName: parsedTransfer.byUserName,
        }
      : null;

    return {
      id: r.id,
      area: r.area,
      tableLabel: r.tableLabel,
      covers: r.covers,
      createdAt: r.createdAt.toISOString(),
      items,
      note: r.note,
      status,
      transfer,
      sale: covering?.sale ?? null,
      ...(() => {
        const { net, vat } = sumTicketLinesNetVat(
          liveItems,
          rowVatEnabled,
          Number((settings as any)?.defaultVatRate || 0),
        );
        return { subtotal: net, vat };
      })(),
    };
  });
}
