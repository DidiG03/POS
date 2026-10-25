import { prisma } from '@db/client';
import { roundMoney } from '@shared/money';
import {
  latestRowPerSession,
  sumTicketLinesNetVat,
} from '@shared/ticketRevenue';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import {
  asTicketLogItems,
  ticketCreatedAtIso,
  ticketLogCreatedAtMs,
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
    return roundMoney(settled);
  }
  const { net, vat } = sumTicketLinesNetVat(
    args.liveItems,
    args.vatEnabled,
    args.defaultVatRate,
  );
  return roundMoney(net + (args.vatEnabled ? vat : 0));
}

/**
 * Sittings for the staff lists. Live ones are the newest snapshot per
 * session. Handed-off ones (moved-out rows left on the source after a table
 * move or owner change) are grouped per waiter as well, so the waiter who
 * handed a table over sees it as Transferred instead of it vanishing; an
 * owner change keeps the session key, so grouping them with the live rows
 * let the new owner's row swallow them. They never claim a sale, so the
 * revenue stays on the destination ticket.
 */
export function staffSittings<
  T extends { id: number; userId?: unknown; note?: string | null },
>(rows: T[]): { live: T[]; movedOut: T[] } {
  const live = latestRowPerSession(
    rows.filter((r) => !isTransferredOutNote(r?.note)) as any[],
  ) as T[];
  const byUser = new Map<number, T[]>();
  for (const r of rows) {
    if (!isTransferredOutNote(r?.note)) continue;
    const uid = Number(r.userId) || 0;
    const list = byUser.get(uid);
    if (list) list.push(r);
    else byUser.set(uid, [r]);
  }
  const movedOut = [...byUser.values()].flatMap(
    (list) => latestRowPerSession(list as any[]) as T[],
  );
  return { live, movedOut };
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
  type Ev = { id: number; atMs: number };
  const tableKey = (r: { area?: string | null; tableLabel?: string | null }) =>
    `${String(r.area || '')}|${String(r.tableLabel || '')}`;
  const sittingsByTable = new Map<string, Ev[]>();
  for (const row of tickets) {
    const at = ticketLogCreatedAtMs(row.createdAt);
    if (!Number.isFinite(at)) continue;
    const key = tableKey(row);
    const arr = sittingsByTable.get(key) || [];
    arr.push({ id: Number(row.id), atMs: at });
    sittingsByTable.set(key, arr);
  }
  const ordersByTable = new Map<string, Ev[]>();
  for (const order of orders) {
    const at = ticketLogCreatedAtMs(order.closedAt);
    if (!Number.isFinite(at)) continue;
    const key = tableKey(order);
    const arr = ordersByTable.get(key) || [];
    arr.push({ id: Number(order.id), atMs: at });
    ordersByTable.set(key, arr);
  }

  const usedOrderIds = new Set<number>();
  const orderIdByTicketId = new Map<number, number>();
  // A payment settles the table's most recent open sitting before it. Pairing
  // each sitting with the first payment after it instead let an abandoned
  // sitting (walkout, 12h auto-void) take the next guest's payment, crediting
  // the wrong waiter and leaving the real sitting unpaid.
  for (const [key, list] of ordersByTable) {
    const sittings = (sittingsByTable.get(key) || []).sort(
      (x, y) => x.atMs - y.atMs,
    );
    list.sort((x, y) => x.atMs - y.atMs);
    const open: Ev[] = [];
    let next = 0;
    for (const order of list) {
      if (usedOrderIds.has(order.id)) continue;
      while (next < sittings.length && sittings[next].atMs <= order.atMs) {
        open.push(sittings[next]);
        next += 1;
      }
      const sitting = open.pop();
      if (!sitting) continue;
      usedOrderIds.add(order.id);
      orderIdByTicketId.set(sitting.id, order.id);
    }
  }
  return { usedOrderIds, orderIdByTicketId };
}

/** Rows a range query may load; the old newest-8000 window cut busy months short. */
const RANGE_ROW_CAP = 50_000;
const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8.64e15;

/**
 * Index-friendly superset of `column` in [startMs, endMs] over every shape a
 * DateTime has been stored in: INTEGER ms or seconds, ISO / `YYYY-MM-DD hh:mm`
 * TEXT, and digit TEXT. Bounds are widened a day so a zone offset or a
 * space-for-T text still lands inside; callers filter exactly in JS with
 * `ticketLogInRange`.
 */
export function dateRangeSupersetSql(
  column: string,
  startMs?: number,
  endMs?: number,
): { sql: string; params: Array<string | number> } | null {
  const hasStart = typeof startMs === 'number' && Number.isFinite(startMs);
  const hasEnd = typeof endMs === 'number' && Number.isFinite(endMs);
  if (!hasStart && !hasEnd) return null;
  const lo = hasStart ? Math.max(0, startMs! - DAY_MS) : 0;
  const hi = hasEnd ? Math.min(MAX_DATE_MS, endMs! + DAY_MS) : MAX_DATE_MS;
  const loSec = Math.floor(lo / 1000);
  const hiSec = Math.ceil(hi / 1000);
  const c = `"${column}"`;
  const between = `(${c} >= ? AND ${c} <= ?)`;
  return {
    sql: `(${[between, between, between, between, between].join(' OR ')})`,
    params: [
      lo,
      hi,
      loSec,
      hiSec,
      new Date(lo).toISOString().slice(0, 10),
      // An open end is `+275760-…` as ISO, which sorts before `2026-…`.
      hasEnd ? `${new Date(hi).toISOString().slice(0, 10)}\uffff` : '\uffff',
      String(lo),
      String(hi),
      String(loSec),
      String(hiSec),
    ],
  };
}

async function idsWhere(
  table: string,
  parts: string[],
  params: Array<string | number>,
): Promise<number[]> {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "id" FROM "${table}" WHERE ${parts.join(' AND ')} ORDER BY "id" DESC LIMIT ?`,
    ...params,
    RANGE_ROW_CAP,
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => asPositiveId(r?.id))
    .filter((id): id is number => id != null);
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
  const inRange = (r: any) => ticketLogInRange(r.createdAt, startMs, endMs);
  const rangeSql = dateRangeSupersetSql('createdAt', startMs, endMs);

  if (rangeSql) {
    try {
      const parts = [rangeSql.sql];
      const params = [...rangeSql.params];
      if (userId) {
        parts.push('"userId" = ?');
        params.push(userId);
      }
      const ids = await idsWhere('TicketLog', parts, params);
      if (ids.length === 0) return [];
      const rows = await prisma.ticketLog.findMany({
        where: { id: { in: ids } },
        orderBy: { id: 'desc' },
      });
      return (rows as any[]).filter(inRange);
    } catch {
      // Fall back to the newest rows filtered in JS.
    }
  }

  const where: any = {};
  if (userId) where.userId = userId;
  const recent = await prisma.ticketLog.findMany({
    where,
    orderBy: { id: 'desc' },
    take,
  });
  return startMs == null && endMs == null
    ? recent
    : (recent as any[]).filter(inRange);
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
  const inRange = (r: any) =>
    ticketLogInRange(r.closedAt ?? r.createdAt, startMs, endMs);
  const closed = dateRangeSupersetSql('closedAt', startMs, endMs);
  const created = dateRangeSupersetSql('createdAt', startMs, endMs);

  if (closed && created) {
    try {
      const parts = [
        `"status" IN ('PAID', 'VOID')`,
        `(${closed.sql} OR ("closedAt" IS NULL AND ${created.sql}))`,
      ];
      const params = [...closed.params, ...created.params];
      if (userId) {
        parts.push('"userId" = ?');
        params.push(userId);
      }
      const ids = await idsWhere('Order', parts, params);
      if (ids.length === 0) return [];
      const rows = await prisma.order.findMany({
        where: { id: { in: ids } },
        orderBy: { id: 'desc' },
        include: PAID_ORDER_INCLUDE,
      } as any);
      return (rows as any[]).filter(inRange);
    } catch {
      // Fall back to the newest rows filtered in JS.
    }
  }

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
  return (rows as any[]).filter(inRange);
}

type StaffSale = {
  vatEnabled: boolean;
  sale: ReturnType<typeof mapOrderToFiscalSaleRow>;
};

/**
 * Every waiter's sittings in range matched against every settled sale, so a
 * paid table belongs to the waiter who served it whoever took the payment.
 * Staff counts and one waiter's ticket list both read this; matching only
 * one waiter's own payments made the two disagree.
 */
/**
 * How far back a sitting can start and still be the one a sale settles: a
 * table open across midnight is paid "today" but was served "yesterday".
 * Auto-void closes any table after 12 hours.
 */
export const SITTING_LOOKBACK_MS = 12 * 60 * 60 * 1000;

async function staffLedger(
  input: { startIso?: string; endIso?: string } | undefined,
  fiscalTin: string,
) {
  const { startMs, endMs } = rangeMs(input);
  const lookbackIso =
    startMs == null
      ? undefined
      : new Date(startMs - SITTING_LOOKBACK_MS).toISOString();
  const logs = await loadTicketLogs({
    startIso: lookbackIso,
    endIso: input?.endIso,
    take: 8000,
  }).catch(() => []);
  const sittings = staffSittings(logs as any[]);
  const allOrders = dedupePaidOrdersBySettlement(
    await loadPaidOrders({
      startIso: lookbackIso,
      endIso: input?.endIso,
      take: 4000,
    }).catch(() => []),
  );
  // Sittings and sales from the hours before the range only settle each
  // other here; the lists and counts show the range itself.
  const inRange = (at: unknown) => ticketLogInRange(at, startMs, endMs);
  const live = sittings.live.filter((r: any) => inRange(r.createdAt));
  const movedOut = sittings.movedOut.filter((r: any) => inRange(r.createdAt));
  const paidOrders = (allOrders as any[]).filter((o) =>
    inRange(o.closedAt ?? o.createdAt),
  );
  // A handed-off ticket is not a sale: only live sittings may claim one.
  const matched = matchOrdersToTicketRows(
    sittings.live as any[],
    allOrders as any[],
  );
  const liveIds = new Set(live.map((r: any) => Number(r.id)));
  const waiterBySitting = new Map(
    (sittings.live as any[]).map((r) => [Number(r.id), Number(r.userId)]),
  );
  const usedOrderIds = new Set<number>();
  const orderIdByTicketId = new Map<number, number>();
  /** Sales in range that settled a sitting begun before it: its waiter's. */
  const servedBy = new Map<number, number>();
  for (const [ticketId, orderId] of matched.orderIdByTicketId) {
    if (liveIds.has(ticketId)) {
      usedOrderIds.add(orderId);
      orderIdByTicketId.set(ticketId, orderId);
    } else {
      const uid = waiterBySitting.get(ticketId);
      if (uid && uid > 0) servedBy.set(orderId, uid);
    }
  }
  const saleByOrderId = new Map<number, StaffSale>();
  for (const order of paidOrders) {
    saleByOrderId.set(Number(order.id), {
      vatEnabled: Boolean(order.vatEnabled),
      sale: mapOrderToFiscalSaleRow(order, { tin: fiscalTin }),
    });
  }
  const saleByLogId = new Map<number, StaffSale>();
  for (const [ticketId, orderId] of orderIdByTicketId) {
    const covering = saleByOrderId.get(orderId);
    if (covering) saleByLogId.set(ticketId, covering);
  }
  const creditedUserId = (order: any): number =>
    servedBy.get(Number(order.id)) ?? Number(order.userId);
  return {
    live,
    movedOut,
    paidOrders,
    usedOrderIds,
    saleByOrderId,
    saleByLogId,
    creditedUserId,
  };
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

  const {
    live,
    movedOut,
    paidOrders,
    usedOrderIds,
    saleByOrderId,
    saleByLogId,
    creditedUserId,
  } = await staffLedger(input, fiscalTin);

  const users = await prisma.user.findMany({
    where: { role: { not: 'ADMIN' } } as any,
  });

  const openShifts = await prisma.dayShift.findMany({
    where: { closedAt: null },
  });
  const openIds = new Set(openShifts.map((s: any) => s.openedById));

  const counts: Record<number, number> = {};
  const paid: Record<number, number> = {};
  const active: Record<number, number> = {};
  const voids: Record<number, number> = {};
  const transferred: Record<number, number> = {};
  const total: Record<number, number> = {};

  const bump = (bag: Record<number, number>, uid: number, n = 1) => {
    bag[uid] = (bag[uid] ?? 0) + n;
  };

  for (const r of [...live, ...movedOut] as any[]) {
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
    const uid = creditedUserId(order);
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
    total: roundMoney(total[u.id] ?? 0),
    /** @deprecated use total */
    revenue: roundMoney(total[u.id] ?? 0),
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
  // Same ledger as the staff counts, then this waiter's slice of it. Matching
  // only this waiter's own payments showed a table a colleague (or the till)
  // took payment for as Active here and Paid on the colleague's page, while
  // the counts credited it to this waiter.
  const {
    live,
    movedOut,
    paidOrders,
    usedOrderIds,
    saleByLogId,
    saleByOrderId,
    creditedUserId,
  } = await staffLedger(input, fiscalTin);
  const visibleRows = [...live, ...movedOut]
    .filter((r: any) => Number(r.userId) === userId)
    .sort((a: any, b: any) => Number(b.id) - Number(a.id))
    .slice(0, limit);

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
    (paidOrders as any[])
      .filter((row) => creditedUserId(row) === userId)
      .map((row) => ({ ...row, orderId: Number(row.id) })),
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
