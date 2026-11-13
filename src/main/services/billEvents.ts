/**
 * The permanent record of what was taken off a bill.
 *
 * A void, a discount, a service charge taken off, a price the till
 * corrected, a table voided for being open too long: each used to exist
 * only as a notification, and notifications are deleted after a week. They
 * are now also written here, one row per event, with who did it, who
 * approved it, the table, the lines and the amount. Rows are never edited
 * and never pruned, and "Erase tickets" leaves them.
 *
 * Writing is best-effort and never throws: the void or the payment it
 * describes has already happened and must not fail because of it. A write
 * that fails is retried once and then logged.
 */
import { prisma } from '@db/client';
import { roundMoney } from '@shared/money';

export type BillEventKind =
  | 'VOID_ITEM'
  | 'VOID_TICKET'
  | 'AUTO_VOID'
  | 'DISCOUNT'
  | 'SERVICE_CHARGE_REMOVED'
  | 'PRICE_CORRECTED'
  /** A bill printed before payment: nothing taken off, but counted. */
  | 'BILL_PRINTED';

export const BILL_EVENT_KINDS: readonly BillEventKind[] = [
  'VOID_ITEM',
  'VOID_TICKET',
  'AUTO_VOID',
  'DISCOUNT',
  'SERVICE_CHARGE_REMOVED',
  'PRICE_CORRECTED',
  'BILL_PRINTED',
];

export type BillEventSource = 'till' | 'phone' | 'auto';

export interface BillEventInput {
  kind: BillEventKind;
  area: string;
  tableLabel: string;
  actorUserId?: number | null;
  approvedById?: number | null;
  amount?: number | null;
  reason?: string | null;
  source?: BillEventSource;
  details?: Record<string, unknown> | null;
}

export interface BillEventRow {
  id: number;
  kind: string;
  area: string;
  tableLabel: string;
  actorUserId: number | null;
  actorName: string | null;
  approvedById: number | null;
  approverName: string | null;
  amount: number | null;
  reason: string | null;
  source: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

type Db = {
  billEvent: {
    create: (args: any) => Promise<unknown>;
    findMany: (args: any) => Promise<any[]>;
    count: (args: any) => Promise<number>;
  };
  user: {
    findMany: (
      args: any,
    ) => Promise<Array<{ id: number; displayName: string; role?: string }>>;
  };
};

export type BillEventDeps = { db?: Db; now?: () => Date };

const MAX_DETAILS_CHARS = 8000;
const SELF_APPROVED_KINDS = new Set<BillEventKind>([
  'VOID_ITEM',
  'VOID_TICKET',
  'DISCOUNT',
  'SERVICE_CHARGE_REMOVED',
]);
const MAX_LINES = 60;

function database(deps?: BillEventDeps): Db {
  return deps?.db ?? (prisma as unknown as Db);
}

function userId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function text(raw: unknown, max: number): string | null {
  const s = String(raw ?? '').trim();
  return s ? s.slice(0, max) : null;
}

export interface BillEventLine {
  name: string;
  sku?: string;
  qty: number;
  unitPrice: number;
}

/** The lines an event took off, trimmed to what a reader needs. */
export function billEventLines(lines: unknown): BillEventLine[] {
  const out: BillEventLine[] = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const l = (raw || {}) as Record<string, unknown>;
    const qty = Number(l.qty ?? 1);
    const unitPrice = Number(l.unitPrice ?? 0);
    out.push({
      name: String(l.name ?? '').trim() || 'Item',
      ...(String(l.sku ?? '').trim() ? { sku: String(l.sku).trim() } : {}),
      qty: Number.isFinite(qty) ? qty : 0,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
    });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/** What those lines were worth on the bill. */
export function billEventLinesAmount(lines: BillEventLine[]): number {
  return roundMoney(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0));
}

function boundedDetails(details: unknown): Record<string, unknown> | null {
  if (!details || typeof details !== 'object') return null;
  try {
    const json = JSON.stringify(details);
    if (json.length <= MAX_DETAILS_CHARS) return JSON.parse(json);
    return { truncated: true, text: json.slice(0, MAX_DETAILS_CHARS) };
  } catch {
    return null;
  }
}

/** True when the row was written. Never throws. */
export async function recordBillEvent(
  input: BillEventInput,
  deps?: BillEventDeps,
): Promise<boolean> {
  const db = database(deps);
  const actorUserId = userId(input.actorUserId);
  let approvedById = userId(input.approvedById);
  const names = new Map<number, string>();
  const roles = new Map<number, string>();
  const ids = [actorUserId, approvedById].filter((n): n is number => n != null);
  if (ids.length) {
    const users = await db.user
      .findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true, role: true },
      })
      .catch(() => []);
    for (const u of users) {
      names.set(Number(u.id), String(u.displayName || ''));
      roles.set(Number(u.id), String(u.role || '').toUpperCase());
    }
  }
  // An admin needs nobody's approval for their own discount or void: the
  // record names them as the approver rather than saying there was none.
  if (
    !approvedById &&
    actorUserId &&
    roles.get(actorUserId) === 'ADMIN' &&
    SELF_APPROVED_KINDS.has(input.kind)
  ) {
    approvedById = actorUserId;
  }
  const amount = Number(input.amount);
  const data = {
    kind: input.kind,
    area: String(input.area || ''),
    tableLabel: String(input.tableLabel || ''),
    actorUserId,
    actorName: actorUserId ? names.get(actorUserId) || null : null,
    approvedById,
    approverName: approvedById ? names.get(approvedById) || null : null,
    amount:
      input.amount != null && Number.isFinite(amount)
        ? roundMoney(amount).toFixed(2)
        : null,
    reason: text(input.reason, 500),
    source: input.source ?? null,
    detailsJson: boundedDetails(input.details) ?? undefined,
    createdAt: deps?.now?.() ?? new Date(),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db.billEvent.create({ data });
      return true;
    } catch (e) {
      lastError = e;
    }
  }
  console.error(
    `[billEvents] could not record ${input.kind} on ${data.area} ${data.tableLabel}`,
    lastError,
  );
  return false;
}

export interface BillEventQuery {
  from?: Date | null;
  to?: Date | null;
  kinds?: string[] | null;
  actorUserId?: number | null;
  limit?: number;
  /** Rows older than this id (for "load more"). */
  beforeId?: number | null;
}

export const BILL_EVENTS_PAGE_MAX = 500;

function validDate(d: unknown): Date | null {
  if (d == null || d === '') return null;
  const out = d instanceof Date ? d : new Date(d as string);
  return Number.isFinite(out.getTime()) ? out : null;
}

/** Newest first. */
export async function listBillEvents(
  query: BillEventQuery = {},
  deps?: BillEventDeps,
): Promise<BillEventRow[]> {
  const from = validDate(query.from);
  const to = validDate(query.to);
  const kinds = (query.kinds || []).filter((k) =>
    (BILL_EVENT_KINDS as readonly string[]).includes(k),
  );
  const actor = userId(query.actorUserId);
  const beforeId = userId(query.beforeId);
  const limit = Math.min(
    BILL_EVENTS_PAGE_MAX,
    Math.max(1, Math.floor(Number(query.limit) || 100)),
  );
  const rows = await database(deps).billEvent.findMany({
    where: {
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(kinds.length ? { kind: { in: kinds } } : {}),
      ...(actor ? { actorUserId: actor } : {}),
      ...(beforeId ? { id: { lt: beforeId } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    area: String(r.area || ''),
    tableLabel: String(r.tableLabel || ''),
    actorUserId: r.actorUserId == null ? null : Number(r.actorUserId),
    actorName: r.actorName ?? null,
    approvedById: r.approvedById == null ? null : Number(r.approvedById),
    approverName: r.approverName ?? null,
    amount: r.amount == null ? null : Number(r.amount),
    reason: r.reason ?? null,
    source: r.source ?? null,
    details: (r.detailsJson as Record<string, unknown>) ?? null,
    createdAt:
      r.createdAt instanceof Date
        ? r.createdAt.toISOString()
        : new Date(r.createdAt).toISOString(),
  }));
}

/** How many events of these kinds happened in `[from, to]`. */
export async function countBillEventsBetween(
  kinds: BillEventKind[],
  from: Date,
  to: Date,
  deps?: BillEventDeps,
): Promise<number> {
  return database(deps).billEvent.count({
    where: { kind: { in: kinds }, createdAt: { gte: from, lte: to } },
  });
}

/** How many events of these kinds one person made since `since`. */
export async function countBillEventsBy(
  actorUserId: number,
  kinds: BillEventKind[],
  since: Date,
  deps?: BillEventDeps,
): Promise<number> {
  return database(deps).billEvent.count({
    where: { actorUserId, kind: { in: kinds }, createdAt: { gte: since } },
  });
}

const EPS = 0.005;

/**
 * The events a recorded payment carries: a discount, the venue's service
 * charge left off, prices the till corrected. `payload` is the payment as
 * recorded (host totals, signed-in user).
 *
 * `approvedById` is only stated where the till checked the approval
 * (`paymentApproval.ts`); otherwise the id is the device's word and goes
 * in the details as such.
 */
export function billEventsOfPayment(
  payload: any,
  settings: any,
  source: BillEventSource,
): BillEventInput[] {
  const meta = (payload?.meta || {}) as Record<string, any>;
  if (String(meta.kind || '').toUpperCase() !== 'PAYMENT') return [];
  if (meta.reprint === true) return [];
  const base = {
    area: String(payload?.area || ''),
    tableLabel: String(payload?.tableLabel || ''),
    actorUserId: userId(meta.userId),
    source,
  };
  const approvals = settings?.security?.approvals || {};
  const claimedApprover = userId(meta.managerApprovedById);
  const paymentKey = text(meta.idempotencyKey ?? payload?.idempotencyKey, 120);
  const out: BillEventInput[] = [];

  const discount = Number(meta.discountAmount);
  if (Number.isFinite(discount) && discount > EPS) {
    const checked = approvals.requireManagerPinForDiscount !== false;
    out.push({
      ...base,
      kind: 'DISCOUNT',
      amount: discount,
      reason: text(meta.discountReason, 500),
      approvedById: checked ? claimedApprover : null,
      details: {
        discountType: meta.discountType ?? null,
        discountValue: meta.discountValue ?? null,
        totalBefore: meta.totalBefore ?? null,
        totalAfter: meta.totalAfter ?? null,
        method: meta.method ?? null,
        ...(!checked && claimedApprover
          ? { approverNamedByDevice: claimedApprover }
          : {}),
        ...(paymentKey ? { paymentKey } : {}),
      },
    });
  }

  const sc = settings?.preferences?.serviceCharge || {};
  if (
    sc.enabled === true &&
    Number(sc.value) > 0 &&
    Number(meta.baseTotal) > EPS &&
    !(Number(meta.serviceChargeAmount) > EPS)
  ) {
    const checked =
      approvals.requireManagerPinForServiceChargeRemoval !== false;
    const wouldBe =
      sc.mode === 'PERCENT'
        ? roundMoney((Number(meta.baseTotal) * Number(sc.value)) / 100)
        : roundMoney(Number(sc.value));
    out.push({
      ...base,
      kind: 'SERVICE_CHARGE_REMOVED',
      amount: wouldBe,
      approvedById: checked ? claimedApprover : null,
      details: {
        mode: sc.mode === 'PERCENT' ? 'PERCENT' : 'AMOUNT',
        value: Number(sc.value),
        baseTotal: meta.baseTotal ?? null,
        totalAfter: meta.totalAfter ?? null,
        ...(!checked && claimedApprover
          ? { approverNamedByDevice: claimedApprover }
          : {}),
        ...(paymentKey ? { paymentKey } : {}),
      },
    });
  }

  const priceDetail = text(meta.linePriceCheck?.detail, 1000);
  const totalsDetail = text(meta.totalsMismatch?.detail, 1000);
  if (priceDetail || totalsDetail) {
    const delta = Number(meta.totalsMismatch?.delta);
    out.push({
      ...base,
      kind: 'PRICE_CORRECTED',
      amount: Number.isFinite(delta) ? Math.abs(delta) : null,
      reason: [priceDetail, totalsDetail].filter(Boolean).join('; '),
      details: {
        claimedTotal: meta.totalsMismatch?.claimedTotal ?? null,
        chargedTotal: meta.totalAfter ?? null,
        issues: Array.isArray(meta.linePriceCheck?.issues)
          ? meta.linePriceCheck.issues.slice(0, MAX_LINES)
          : [],
        ...(paymentKey ? { paymentKey } : {}),
      },
    });
  }
  return out;
}

/** Record what a just-recorded payment carried. Never throws. */
export async function recordPaymentBillEvents(
  payload: any,
  settings: any,
  source: BillEventSource,
  sale?: { orderId?: number | null },
  deps?: BillEventDeps,
): Promise<void> {
  try {
    const orderId = userId(sale?.orderId);
    for (const event of billEventsOfPayment(payload, settings, source)) {
      await recordBillEvent(
        orderId
          ? { ...event, details: { ...(event.details || {}), orderId } }
          : event,
        deps,
      );
    }
  } catch (e) {
    console.error('[billEvents] could not record payment events', e);
  }
}
