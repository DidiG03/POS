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
import { keepCanonicalPaidOrders } from '@shared/paidSaleDedupe';

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

/** Newest-id-first union. Raw SQL can miss mixed SQLite DateTime shapes. */
export function unionTicketLogsById<T extends { id: number }>(
  a: T[],
  b: T[],
): T[] {
  const byId = new Map<number, T>();
  for (const row of a) byId.set(Number(row.id), row);
  for (const row of b) {
    const id = Number(row.id);
    if (!byId.has(id)) byId.set(id, row);
  }
  return [...byId.values()].sort((x, y) => Number(y.id) - Number(x.id));
}

export function paidSalesNotOnTickets<T extends { orderId: number }>(
  usedOrderIds: Set<number>,
  sales: T[],
): T[] {
  return sales.filter((sale) => !usedOrderIds.has(Number(sale.orderId)));
}

/** @deprecated use keepCanonicalPaidOrders */
export function dedupePaidOrdersBySettlement<
  T extends {
    id?: number;
    userId?: number | null;
    area?: string | null;
    tableLabel?: string | null;
    total?: number | null;
    closedAt?: unknown;
    createdAt?: unknown;
    payments?: Array<{
      metaJson?: unknown;
      fiscalNslf?: string | null;
      fiscalNivf?: string | null;
    }>;
  },
>(orders: T[]): T[] {
  return keepCanonicalPaidOrders(orders);
}

export type AdminTicketStatus = 'PAID' | 'VOIDED' | 'ACTIVE' | 'TRANSFERRED';

/**
 * Closed tables without a matched sale stay ACTIVE (unpaid / abandoned).
 * Defaulting those to PAID used to double-count unmatched Orders and inflate
 * staff revenue for walkouts.
 */
export function resolveAdminTicketStatus(args: {
  isVoided: boolean;
  isTransferred: boolean;
  isPaid: boolean;
}): AdminTicketStatus {
  if (args.isVoided) return 'VOIDED';
  if (args.isTransferred) return 'TRANSFERRED';
  if (args.isPaid) return 'PAID';
  return 'ACTIVE';
}

/** Prefer settled Order.total; fall back to VAT-inclusive line goods. */
export function adminTicketRevenueAmount(args: {
  settledTotal?: number | null;
  liveItems: unknown;
  vatEnabled: boolean;
  defaultVatRate: number;
}): number {
  const settled = Number(args.settledTotal);
  if (Number.isFinite(settled) && settled > 0) {
    return Math.round(settled * 100) / 100;
  }
  const { net, vat } = sumTicketLinesNetVat(
    args.liveItems,
    args.vatEnabled,
    args.defaultVatRate,
  );
  return Math.round((net + (args.vatEnabled ? vat : 0)) * 100) / 100;
}

export function matchOrdersToTicketRows(
  tickets: Array<{
    id: number;
    area?: string | null;
    tableLabel?: string | null;
    createdAt?: unknown;
  }>,
  orders: Array<{
    id: number;
    area?: string | null;
    tableLabel?: string | null;
    closedAt?: unknown;
  }>,
): { usedOrderIds: Set<number>; orderIdByTicketId: Map<number, number> } {
  const byTable = new Map<string, { id: number; atMs: number }[]>();
  for (const order of orders) {
    const at = ticketLogCreatedAtMs(order.closedAt);
    if (!Number.isFinite(at)) continue;
    const key = `${String(order.area || '')}|${String(order.tableLabel || '')}`;
    const arr = byTable.get(key) || [];
    arr.push({ id: Number(order.id), atMs: at });
    byTable.set(key, arr);
  }
  for (const arr of byTable.values()) arr.sort((a, b) => a.atMs - b.atMs);

  const usedOrderIds = new Set<number>();
  const orderIdByTicketId = new Map<number, number>();
  const chronological = [...tickets].sort((a, b) => {
    const ta = ticketLogCreatedAtMs(a.createdAt);
    const tb = ticketLogCreatedAtMs(b.createdAt);
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });
  for (const row of chronological) {
    const key = `${String(row.area || '')}|${String(row.tableLabel || '')}`;
    const rowMs = ticketLogCreatedAtMs(row.createdAt);
    const covering = (byTable.get(key) || []).find(
      (p) =>
        Number.isFinite(rowMs) && p.atMs >= rowMs && !usedOrderIds.has(p.id),
    );
    if (!covering) continue;
    usedOrderIds.add(covering.id);
    orderIdByTicketId.set(Number(row.id), covering.id);
  }
  return { usedOrderIds, orderIdByTicketId };
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

  let rawRows: any[] = [];
  try {
    const ids = await viaRaw();
    if (ids && ids.length) {
      rawRows = await prisma.ticketLog.findMany({
        where: { id: { in: ids } },
      });
    }
  } catch {
    // Prisma + JS filter below still recovers mixed DateTime rows.
  }

  const where: any = {};
  if (userId) where.userId = userId;
  const recent = await prisma.ticketLog.findMany({
    where,
    orderBy: { id: 'desc' },
    take,
  });
  const jsRows =
    startMs == null && endMs == null
      ? recent
      : recent.filter((r: any) =>
          ticketLogInRange(r.createdAt, startMs, endMs),
        );
  return unionTicketLogsById(
    rawRows as { id: number }[],
    jsRows as { id: number }[],
  );
}

const PAID_ORDER_INCLUDE = {
  items: { orderBy: { sortOrder: 'asc' as const } },
  payments: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  corrections: { orderBy: { createdAt: 'desc' as const } },
};

async function loadPaidOrders(input?: {
  userId?: number;
  startIso?: string;
  endIso?: string;
  take?: number;
}) {
  const take = Math.min(4000, Math.max(1, Number(input?.take || 2000)));
  const userId = Number(input?.userId) || 0;
  const { startMs, endMs } = rangeMs(input);
  const where: any = { status: { in: ['PAID', 'VOID'] } };
  if (userId) where.userId = userId;
  const rows = await prisma.order
    .findMany({
      where,
      orderBy: { id: 'desc' },
      take,
      include: PAID_ORDER_INCLUDE,
    } as any)
    .catch(() => []);
  if (startMs == null && endMs == null) return rows as any[];
  return (rows as any[]).filter((r) =>
    ticketLogInRange(r.closedAt ?? r.createdAt, startMs, endMs),
  );
}

export async function listAdminTicketCounts(input?: {
  startIso?: string;
  endIso?: string;
}) {
  const { startMs, endMs } = rangeMs(input);
  const settings = await coreServices.readSettings().catch(() => ({}));
  const defaultVatEnabled = isVatEnabledFromSettings(settings);
  const defaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  const fiscalTin = String((settings as any)?.fiscal?.nipt || '').trim();

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

  const openShifts = await prisma.dayShift.findMany({
    where: { closedAt: null },
  });
  const openIds = new Set(openShifts.map((s: any) => s.openedById));

  const paidOrders = dedupePaidOrdersBySettlement(
    await loadPaidOrders({
      startIso: input?.startIso,
      endIso: input?.endIso,
      take: 4000,
    }).catch(() => []),
  );
  const { usedOrderIds, orderIdByTicketId } = matchOrdersToTicketRows(
    live as any[],
    paidOrders as any[],
  );
  const saleByOrderId = new Map<
    number,
    { vatEnabled: boolean; sale: ReturnType<typeof mapOrderToFiscalSaleRow> }
  >();
  for (const order of paidOrders as any[]) {
    saleByOrderId.set(Number(order.id), {
      vatEnabled: Boolean(order.vatEnabled),
      sale: mapOrderToFiscalSaleRow(order, { tin: fiscalTin }),
    });
  }
  const saleByLogId = new Map<
    number,
    { vatEnabled: boolean; sale: ReturnType<typeof mapOrderToFiscalSaleRow> }
  >();
  for (const [ticketId, orderId] of orderIdByTicketId) {
    const covering = saleByOrderId.get(orderId);
    if (covering) saleByLogId.set(ticketId, covering);
  }

  const counts: Record<number, number> = {};
  const paid: Record<number, number> = {};
  const active: Record<number, number> = {};
  const voids: Record<number, number> = {};
  const transferred: Record<number, number> = {};
  const total: Record<number, number> = {};

  const bump = (bag: Record<number, number>, uid: number, n = 1) => {
    bag[uid] = (bag[uid] ?? 0) + n;
  };

  for (const r of live as any[]) {
    const uid = Number(r.userId);
    if (!Number.isInteger(uid) || uid <= 0) continue;
    if (!ticketLogInRange(r.createdAt, startMs, endMs)) continue;
    bump(counts, uid);

    const items = asTicketLogItems(r.itemsJson) as any[];
    const liveItems = items.filter((it: any) => !it?.voided);
    const noteStr = String(r.note || '').toUpperCase();
    const allVoided =
      items.length > 0 && items.every((it: any) => it?.voided === true);
    const covering = saleByLogId.get(Number(r.id));
    const saleVoided =
      String(covering?.sale.status || '').toUpperCase() === 'VOID';
    const isVoided = allVoided || /\bVOIDED\b/.test(noteStr) || saleVoided;
    const isTransferred = isTransferredOutNote(r.note);
    const isPaid = Boolean(covering);
    const status = resolveAdminTicketStatus({
      isVoided,
      isTransferred,
      isPaid,
    });

    if (status === 'VOIDED') bump(voids, uid);
    else if (status === 'ACTIVE') bump(active, uid);
    else if (status === 'TRANSFERRED') bump(transferred, uid);
    else bump(paid, uid);

    // Revenue is settled money only — open/abandoned tickets stay out.
    if (status === 'PAID') {
      bump(
        total,
        uid,
        adminTicketRevenueAmount({
          settledTotal: covering?.sale?.total,
          liveItems,
          vatEnabled: defaultVatEnabled,
          defaultVatRate,
        }),
      );
    }
  }

  for (const order of paidSalesNotOnTickets(
    usedOrderIds,
    (paidOrders as any[]).map((row) => ({ ...row, orderId: Number(row.id) })),
  )) {
    const uid = Number(order.userId);
    if (!Number.isInteger(uid) || uid <= 0) continue;
    bump(counts, uid);
    const covering = saleByOrderId.get(Number(order.id));
    const items = (Array.isArray(order.items) ? order.items : []).map(
      (it: any) => ({
        name: String(it?.name || 'Item'),
        qty: Number(it?.qty || 1),
        unitPrice: Number(it?.unitPrice || 0),
        vatRate: Number(it?.vatRate || 0),
        voided: it?.voidedAt != null || it?.voided === true,
      }),
    );
    const liveItems = items.filter((it: any) => !it?.voided);
    const saleVoided =
      String(covering?.sale.status || order.status || '').toUpperCase() ===
      'VOID';
    if (saleVoided) {
      bump(voids, uid);
    } else {
      bump(paid, uid);
      bump(
        total,
        uid,
        adminTicketRevenueAmount({
          settledTotal: covering?.sale?.total ?? order.total,
          liveItems,
          vatEnabled: defaultVatEnabled,
          defaultVatRate,
        }),
      );
    }
  }

  return users.map((u: any) => ({
    id: u.id,
    name: u.displayName,
    active: openIds.has(u.id),
    tickets: counts[u.id] ?? 0,
    paid: paid[u.id] ?? 0,
    activeTickets: active[u.id] ?? 0,
    voids: voids[u.id] ?? 0,
    transferred: transferred[u.id] ?? 0,
    /** @deprecated use transferred — kept for older clients */
    transfersIn: transferred[u.id] ?? 0,
    total: Math.round((total[u.id] ?? 0) * 100) / 100,
    /** @deprecated use total */
    revenue: Math.round((total[u.id] ?? 0) * 100) / 100,
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
    take: 8000,
  });

  const visibleRows = latestRowPerSession(
    (rows as any[]).filter((r: any) => !isTransferredOutNote(r?.note)),
  ).slice(0, limit);

  const paidOrders = dedupePaidOrdersBySettlement(
    await loadPaidOrders({
      userId,
      startIso: input?.startIso,
      endIso: input?.endIso,
      take: 4000,
    }).catch(() => []),
  );
  const { usedOrderIds, orderIdByTicketId } = matchOrdersToTicketRows(
    visibleRows as any[],
    paidOrders as any[],
  );
  const saleByOrderId = new Map<
    number,
    { vatEnabled: boolean; sale: ReturnType<typeof mapOrderToFiscalSaleRow> }
  >();
  for (const order of paidOrders as any[]) {
    saleByOrderId.set(Number(order.id), {
      vatEnabled: Boolean(order.vatEnabled),
      sale: mapOrderToFiscalSaleRow(order, { tin: fiscalTin }),
    });
  }
  const saleByLogId = new Map<
    number,
    { vatEnabled: boolean; sale: ReturnType<typeof mapOrderToFiscalSaleRow> }
  >();
  for (const [ticketId, orderId] of orderIdByTicketId) {
    const covering = saleByOrderId.get(orderId);
    if (covering) saleByLogId.set(ticketId, covering);
  }

  const fromLogs = visibleRows.map((r: any) => {
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

    const status = resolveAdminTicketStatus({
      isVoided,
      isTransferred: isTransferredOut,
      isPaid,
    });

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
          defaultVatEnabled,
          Number((settings as any)?.defaultVatRate || 0),
        );
        return { subtotal: net, vat };
      })(),
    };
  });

  const unmatchedOrders = paidSalesNotOnTickets(
    usedOrderIds,
    (paidOrders as any[]).map((row) => ({ ...row, orderId: Number(row.id) })),
  );
  const defaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  const fromOrders = unmatchedOrders.map((order: any) => {
    const covering = saleByOrderId.get(Number(order.id));
    const items = (Array.isArray(order.items) ? order.items : []).map(
      (it: any) => ({
        name: String(it?.name || 'Item'),
        qty: Number(it?.qty || 1),
        unitPrice: Number(it?.unitPrice || 0),
        vatRate: Number(it?.vatRate || 0),
        note: it?.note,
        voided: it?.voidedAt != null || it?.voided === true,
      }),
    );
    const liveItems = items.filter((it: any) => !it?.voided);
    const saleVoided =
      String(covering?.sale.status || order.status || '').toUpperCase() ===
      'VOID';
    const { net, vat } = sumTicketLinesNetVat(
      liveItems,
      defaultVatEnabled,
      defaultVatRate,
    );
    return {
      id: -Number(order.id),
      area: String(order.area || ''),
      tableLabel: String(order.tableLabel || ''),
      covers: order.covers ?? null,
      createdAt: ticketCreatedAtIso(order.closedAt ?? order.createdAt),
      items,
      note: order.note ?? null,
      status: (saleVoided ? 'VOIDED' : 'PAID') as
        | 'PAID'
        | 'VOIDED'
        | 'ACTIVE'
        | 'TRANSFERRED',
      transfer: null,
      sale: covering?.sale ?? null,
      subtotal: net,
      vat,
    };
  });

  return [...fromLogs, ...fromOrders]
    .sort(
      (a, b) =>
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
    )
    .slice(0, limit);
}
