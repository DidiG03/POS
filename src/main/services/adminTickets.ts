import { prisma } from '@db/client';
import {
  latestRowPerSession,
  sumTicketLinesNetVat,
} from '@shared/ticketRevenue';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import {
  asTicketLogItems,
  ticketCreatedAtIso,
  ticketLogCreatedAtMs,
  ticketLogCreatedAtRangeSql,
  ticketLogInRange,
} from '@shared/ticketLogItems';
import { asPositiveId } from './ticketLogLatest';
import { coreServices } from './core';
import { mapOrderToFiscalSaleRow } from './saleCorrection';
import { isTransferredOutNote, parseTransferTag } from './tableTransfer';

function rangeMs(input?: { startIso?: string; endIso?: string }): {
  startMs?: number;
  endMs?: number;
} {
  const startMs = input?.startIso ? Date.parse(input.startIso) : NaN;
  const endMs = input?.endIso ? Date.parse(input.endIso) : NaN;
  return {
    startMs: Number.isFinite(startMs) ? startMs : undefined,
    endMs: Number.isFinite(endMs) ? endMs : undefined,
  };
}

async function loadTicketLogs(input?: {
  userId?: number;
  startIso?: string;
  endIso?: string;
  take?: number;
}) {
  const take = Math.min(8000, Math.max(1, Number(input?.take || 2000)));
  const userId = Number(input?.userId) || 0;
  const { startMs, endMs } = rangeMs(input);
  const rangeSql = ticketLogCreatedAtRangeSql(startMs, endMs);

  const viaRaw = async (): Promise<number[] | null> => {
    if (!rangeSql && !userId) return null;
    const parts = ['1=1'];
    const params: Array<string | number> = [];
    if (userId) {
      parts.push('userId = ?');
      params.push(userId);
    }
    if (rangeSql) {
      parts.push(rangeSql.sql);
      params.push(...rangeSql.params);
    }
    const sql = `SELECT id FROM TicketLog WHERE ${parts.join(' AND ')} ORDER BY id DESC LIMIT ?`;
    params.push(take);
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r: any) => asPositiveId(r?.id))
      .filter((id): id is number => id != null);
  };

  try {
    const ids = await viaRaw();
    if (ids && ids.length) {
      const rows = await prisma.ticketLog.findMany({
        where: { id: { in: ids } },
      });
      rows.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      return rows;
    }
  } catch {
    // Fall through to Prisma + JS filter when raw SQL is unavailable.
  }

  const where: any = {};
  if (userId) where.userId = userId;
  const rows = await prisma.ticketLog.findMany({
    where,
    orderBy: { id: 'desc' },
    take,
  });
  if (startMs == null && endMs == null) return rows;
  return rows.filter((r: any) => ticketLogInRange(r.createdAt, startMs, endMs));
}

export async function listAdminTicketCounts(input?: {
  startIso?: string;
  endIso?: string;
}) {
  const { startMs, endMs } = rangeMs(input);
  const logs = await loadTicketLogs({
    startIso: input?.startIso,
    endIso: input?.endIso,
    take: 8000,
  }).catch(() => []);
  const live = latestRowPerSession(
    (logs as any[]).filter((r: any) => !isTransferredOutNote(r?.note)),
  );

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
  const transfersIn: Record<number, number> = {};
  for (const r of live as any[]) {
    const uid = Number(r.userId);
    if (!Number.isInteger(uid) || uid <= 0) continue;
    if (!ticketLogInRange(r.createdAt, startMs, endMs)) continue;
    counts[uid] = (counts[uid] ?? 0) + 1;
    if (/\[TRANSFER/i.test(String(r.note || ''))) {
      transfersIn[uid] = (transfersIn[uid] ?? 0) + 1;
    }
  }

  const visibleUsers = users.filter((u: any) => {
    const id = Number(u.id);
    if ((counts[id] ?? 0) > 0 || (transfersIn[id] ?? 0) > 0) return true;
    if (openIds.has(id)) return true;
    if (clockedInDuringPeriod) return clockedInDuringPeriod.has(id);
    return true;
  });

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
  const limit = Math.min(2000, Math.max(1, Number(input?.limit || 500)));
  const rows = await loadTicketLogs({
    userId,
    startIso: input?.startIso,
    endIso: input?.endIso,
    take: Math.min(8000, Math.max(limit * 4, limit)),
  });

  const visibleRows = latestRowPerSession(
    (rows as any[]).filter((r: any) => !isTransferredOutNote(r?.note)),
  ).slice(0, limit);

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
        const ms = ticketLogCreatedAtMs(r.createdAt);
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
      const at = sale.closedAt ? ticketLogCreatedAtMs(sale.closedAt) : NaN;
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
  const chronological = [...(visibleRows as any[])].sort((a, b) => {
    const ta = ticketLogCreatedAtMs(a.createdAt);
    const tb = ticketLogCreatedAtMs(b.createdAt);
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
  for (const r of chronological) {
    const tKey = `${r.area}|${r.tableLabel}`;
    const rowMs = ticketLogCreatedAtMs(r.createdAt);
    const covering = (paymentsByTable.get(tKey) || []).find(
      (p) =>
        Number.isFinite(rowMs) &&
        p.atMs >= rowMs &&
        !usedOrderIds.has(p.sale.orderId),
    );
    if (!covering) continue;
    usedOrderIds.add(covering.sale.orderId);
    saleByLogId.set(Number(r.id), covering);
  }

  return visibleRows.map((r: any) => {
    const items = asTicketLogItems(r.itemsJson) as any[];
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
      createdAt: ticketCreatedAtIso(r.createdAt),
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
