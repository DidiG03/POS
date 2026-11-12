/**
 * "Unusual activity" notices for admins: many voids by one person, a void
 * shortly after a payment on the same table, repeated discounts, repeated
 * service-charge removals.
 *
 * These checks used to live inside the LAN API only, so they ran for
 * phones and tablets and never for a cashier working at the till itself.
 * Both the till (IPC) and the LAN API now call the two functions here.
 *
 * The thresholds are deliberately loose: each notice says the pattern can
 * be normal, and an admin gets at most one of each kind per hour.
 */
import { prisma } from '@db/client';
import { isPaymentReprint } from './paymentSettle';

export const VOID_ITEM_PREFIX = 'Voided item on ';
export const VOID_TICKET_PREFIX = 'Voided ticket on ';
export const UNUSUAL_PREFIX = 'Unusual activity (auto-check):';
export const LAST_PAYMENT_KEY = 'antitheft:lastPaymentAt';

export const WINDOW_MINUTES = 60;
export const COOLDOWN_MINUTES = 60;
export const VOID_ITEM_THRESHOLD = 6;
export const VOID_TICKET_THRESHOLD = 3;
export const VOID_AFTER_PAYMENT_MINUTES = 10;
export const DISCOUNT_THRESHOLD = 5;
export const SERVICE_REMOVAL_THRESHOLD = 3;

export type VoidKind = 'VOID_ITEM' | 'VOID_TICKET';

type Db = {
  billEvent: { count: (args: object) => Promise<number> };
  notification: {
    count: (args: object) => Promise<number>;
    create: (args: object) => Promise<unknown>;
  };
  user: {
    findUnique: (args: object) => Promise<{ displayName?: string } | null>;
    findMany: (args: object) => Promise<Array<{ id: number }>>;
  };
  syncState: {
    findUnique: (args: object) => Promise<{ valueJson?: unknown } | null>;
    upsert: (args: object) => Promise<unknown>;
  };
};

export type FraudAlertDeps = { db?: Db; now?: () => number };

type PayAdjust = {
  discountCount: number;
  serviceRemovalCount: number;
  resetAt: number;
  lastAlertAt: number;
};

// Per-person counters for the current hour. In memory: a restart starts the
// hour again, which only delays a notice.
const payAdjustByUser = new Map<number, PayAdjust>();

function database(deps?: FraudAlertDeps): Db {
  return deps?.db ?? (prisma as unknown as Db);
}

function tableKey(area: string, tableLabel: string): string {
  return `${area}:${tableLabel}`;
}

async function actorNameOf(db: Db, userId: number): Promise<string> {
  const actor = await db.user
    .findUnique({ where: { id: userId } })
    .catch(() => null);
  return actor?.displayName ? String(actor.displayName) : `User #${userId}`;
}

async function activeAdmins(db: Db): Promise<Array<{ id: number }>> {
  return db.user
    .findMany({ where: { role: 'ADMIN', active: true }, take: 50 })
    .catch(() => []);
}

/** One SECURITY notice per admin, skipping admins who had `marker` recently. */
async function notifyAdminsOnce(
  db: Db,
  message: string,
  marker: { startsWith: string } | { includes: string },
  nowMs: number,
): Promise<void> {
  const since = new Date(nowMs - COOLDOWN_MINUTES * 60_000);
  for (const admin of await activeAdmins(db)) {
    const already = await db.notification
      .count({
        where: {
          userId: admin.id,
          type: 'SECURITY',
          createdAt: { gte: since },
          message: marker,
        },
      })
      .catch(() => 0);
    if (already > 0) continue;
    await db.notification
      .create({ data: { userId: admin.id, type: 'SECURITY', message } })
      .catch(() => undefined);
  }
}

async function alertManyVoids(
  db: Db,
  actorUserId: number,
  kind: VoidKind,
  nowMs: number,
): Promise<void> {
  const threshold =
    kind === 'VOID_TICKET' ? VOID_TICKET_THRESHOLD : VOID_ITEM_THRESHOLD;
  // Counted from the permanent record of voids (`billEvents.ts`). It used
  // to be counted from the wording of notifications, which a change of
  // text or language would have switched off without a sound.
  const count = await db.billEvent
    .count({
      where: {
        actorUserId,
        kind,
        createdAt: { gte: new Date(nowMs - WINDOW_MINUTES * 60_000) },
      },
    })
    .catch(() => 0);
  if (count < threshold) return;
  const actorName = await actorNameOf(db, actorUserId);
  const what = kind === 'VOID_TICKET' ? 'voided tickets' : 'voided items';
  await notifyAdminsOnce(
    db,
    `${UNUSUAL_PREFIX} ${count} ${what} by ${actorName} in the last ${WINDOW_MINUTES} minutes. This can be normal during corrections; please review if unexpected.`,
    { startsWith: UNUSUAL_PREFIX },
    nowMs,
  );
}

async function alertVoidSoonAfterPayment(
  db: Db,
  input: {
    actorUserId: number;
    area: string;
    tableLabel: string;
    kind: VoidKind;
  },
  nowMs: number,
): Promise<void> {
  const row = await db.syncState
    .findUnique({ where: { key: LAST_PAYMENT_KEY } })
    .catch(() => null);
  const map = (row?.valueJson || {}) as Record<string, string>;
  const lastIso = map[tableKey(input.area, input.tableLabel)];
  if (!lastIso) return;
  const deltaMs = nowMs - new Date(lastIso).getTime();
  if (
    !Number.isFinite(deltaMs) ||
    deltaMs < 0 ||
    deltaMs > VOID_AFTER_PAYMENT_MINUTES * 60_000
  ) {
    return;
  }
  const actorName = await actorNameOf(db, input.actorUserId);
  const minutesAgo = Math.max(0, Math.round(deltaMs / 60_000));
  const what =
    input.kind === 'VOID_TICKET' ? 'voided a ticket' : 'voided an item';
  await notifyAdminsOnce(
    db,
    `${UNUSUAL_PREFIX} ${actorName} ${what} on ${input.area} Table ${input.tableLabel} about ${minutesAgo} minutes after payment. ` +
      `This can be normal (corrections/reprints); please review if unexpected.`,
    { includes: 'minutes after payment' },
    nowMs,
  );
}

/**
 * Call after a void was recorded (and its bill event written).
 * Never throws: an alert must not fail the void.
 */
export async function checkVoidForAlerts(
  input: {
    actorUserId: number;
    area: string;
    tableLabel: string;
    kind: VoidKind;
  },
  deps?: FraudAlertDeps,
): Promise<void> {
  const actorUserId = Number(input.actorUserId) || 0;
  if (!actorUserId) return;
  const db = database(deps);
  const nowMs = deps?.now?.() ?? Date.now();
  try {
    await alertManyVoids(db, actorUserId, input.kind, nowMs);
    await alertVoidSoonAfterPayment(
      db,
      {
        actorUserId,
        area: String(input.area || ''),
        tableLabel: String(input.tableLabel || ''),
        kind: input.kind,
      },
      nowMs,
    );
  } catch {
    // best-effort
  }
}

/**
 * Call for every payment taken (not a reprint of an old receipt): remembers
 * when the table was paid, and counts this person's discounts and
 * service-charge removals for the hour. Never throws.
 */
export async function checkPaymentForAlerts(
  input: {
    actorUserId: number;
    area: string;
    tableLabel: string;
    meta: unknown;
  },
  deps?: FraudAlertDeps,
): Promise<void> {
  const meta = (input.meta || {}) as Record<string, unknown>;
  if (String(meta.kind || '').toUpperCase() !== 'PAYMENT') return;
  if (isPaymentReprint(meta)) return;
  const db = database(deps);
  const nowMs = deps?.now?.() ?? Date.now();
  try {
    const row = await db.syncState
      .findUnique({ where: { key: LAST_PAYMENT_KEY } })
      .catch(() => null);
    const map = {
      ...((row?.valueJson || {}) as Record<string, string>),
      [tableKey(String(input.area || ''), String(input.tableLabel || ''))]:
        new Date(nowMs).toISOString(),
    };
    await db.syncState
      .upsert({
        where: { key: LAST_PAYMENT_KEY },
        create: { key: LAST_PAYMENT_KEY, valueJson: map },
        update: { valueJson: map },
      })
      .catch(() => undefined);

    const userId = Number(input.actorUserId) || 0;
    if (!userId) return;
    const discountAmt = Number(meta.discountAmount || 0);
    const scAmt = Number(meta.serviceChargeAmount || 0);
    const serviceRemoved =
      Boolean(meta.serviceChargeEnabled) &&
      !meta.serviceChargeApplied &&
      Number.isFinite(scAmt) &&
      scAmt > 0;

    const cur = payAdjustByUser.get(userId);
    const st: PayAdjust =
      !cur || cur.resetAt <= nowMs
        ? {
            discountCount: 0,
            serviceRemovalCount: 0,
            resetAt: nowMs + WINDOW_MINUTES * 60_000,
            lastAlertAt: cur?.lastAlertAt || 0,
          }
        : cur;
    if (Number.isFinite(discountAmt) && discountAmt > 0) st.discountCount += 1;
    if (serviceRemoved) st.serviceRemovalCount += 1;
    payAdjustByUser.set(userId, st);

    const canAlert =
      !st.lastAlertAt || nowMs - st.lastAlertAt > COOLDOWN_MINUTES * 60_000;
    if (!canAlert) return;
    let message: string | null = null;
    if (st.discountCount >= DISCOUNT_THRESHOLD) {
      message =
        `${UNUSUAL_PREFIX} ${st.discountCount} discounted payments by ${await actorNameOf(db, userId)} in the last ${WINDOW_MINUTES} minutes. ` +
        `This can be normal during promotions; please review if unexpected.`;
    } else if (st.serviceRemovalCount >= SERVICE_REMOVAL_THRESHOLD) {
      message =
        `${UNUSUAL_PREFIX} ${st.serviceRemovalCount} service charge removals by ${await actorNameOf(db, userId)} in the last ${WINDOW_MINUTES} minutes. ` +
        `This can be normal during corrections; please review if unexpected.`;
    }
    if (!message) return;
    for (const admin of await activeAdmins(db)) {
      await db.notification
        .create({ data: { userId: admin.id, type: 'SECURITY', message } })
        .catch(() => undefined);
    }
    st.lastAlertAt = nowMs;
  } catch {
    // best-effort
  }
}

/** Test seam. */
export function __resetFraudAlertsForTests(): void {
  payAdjustByUser.clear();
}
