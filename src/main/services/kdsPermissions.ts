/**
 * Who may work the kitchen display, and a record of who did (QA round 6, #8).
 *
 * Any signed-in waiter could bump, recall and clear the kitchen display
 * over the LAN, and nothing said who did it. Now:
 *   - bump and recall: a paired kitchen display, or kitchen and bar staff
 *     (and the till's managers); not waiters, hosts or cleaners;
 *   - "Clear Done" deletes the day's finished cards for a station: it
 *     needs a manager, signed in or by PIN on the display;
 *   - each bump, recall and clear is logged with who did it.
 */
import { prisma } from '@db/client';
import { logSecurityEvent } from './security';

/** Staff (and the `KDS` device role) who may bump and recall cards. */
export const KDS_STAFF_ROLES = [
  'KDS',
  'ADMIN',
  'CASHIER',
  'KP',
  'CHEF',
  'HEAD_CHEF',
  'FOOD_RUNNER',
  'BARTENDER',
  'BARBACK',
] as const;

/** Roles that may clear a station's Done cards without a PIN. */
export const KDS_MANAGER_ROLES = ['ADMIN'] as const;

export const KDS_MANAGER_REQUIRED = 'MANAGER_REQUIRED';

export function kdsActionAllowed(role: unknown): boolean {
  return (KDS_STAFF_ROLES as readonly string[]).includes(
    String(role || '').toUpperCase(),
  );
}

export function kdsClearAllowedWithoutPin(role: unknown): boolean {
  return (KDS_MANAGER_ROLES as readonly string[]).includes(
    String(role || '').toUpperCase(),
  );
}

export type KdsAction = 'bump' | 'bump-item' | 'recall' | 'clear-done';

export type KdsActionEntry = {
  at: string;
  action: KdsAction;
  station: string;
  ticketId: number | null;
  itemIdx: number | null;
  /** Signed-in staff member, or null for a paired display. */
  actorUserId: number | null;
  actorName: string | null;
  /** `display` (paired KDS), `staff` (signed in) or `till` (its KDS window). */
  via: 'display' | 'staff' | 'till';
  /** The manager whose PIN allowed a clear. */
  approvedById?: number | null;
  approvedByName?: string | null;
  /** What came of it: cards cleared, or the bump outcome. */
  result?: string;
};

export const KDS_ACTION_LOG_KEY = 'kds:actionLog';
const LOG_LIMIT = 2000;

async function nameOf(
  userId: number | null | undefined,
): Promise<string | null> {
  const id = Number(userId || 0);
  if (!id) return null;
  const u = await prisma.user
    .findUnique({ where: { id }, select: { displayName: true } } as any)
    .catch(() => null);
  return String((u as any)?.displayName || '').trim() || null;
}

// One write at a time: entries of two quick bumps must not overwrite
// each other in the read-modify-write below.
let chain: Promise<unknown> = Promise.resolve();

/** Record a kitchen action. Never throws: a log problem must not undo it. */
export function recordKdsAction(
  input: Omit<KdsActionEntry, 'at' | 'actorName' | 'approvedByName'> & {
    now?: Date;
  },
): Promise<void> {
  const run = async () => {
    try {
      const entry: KdsActionEntry = {
        at: (input.now ?? new Date()).toISOString(),
        action: input.action,
        station: String(input.station || '').toUpperCase(),
        ticketId: Number(input.ticketId) || null,
        itemIdx:
          input.itemIdx != null && Number.isFinite(Number(input.itemIdx))
            ? Number(input.itemIdx)
            : null,
        actorUserId: Number(input.actorUserId) || null,
        actorName: await nameOf(input.actorUserId),
        via: input.via,
        ...(input.approvedById
          ? {
              approvedById: Number(input.approvedById),
              approvedByName: await nameOf(input.approvedById),
            }
          : {}),
        ...(input.result ? { result: input.result } : {}),
      };
      logSecurityEvent(`kds_${entry.action.replace('-', '_')}`, entry);
      const row = await prisma.syncState
        .findUnique({ where: { key: KDS_ACTION_LOG_KEY } })
        .catch(() => null);
      const entries = Array.isArray((row?.valueJson as any)?.entries)
        ? ((row!.valueJson as any).entries as KdsActionEntry[])
        : [];
      entries.push(entry);
      const valueJson = { entries: entries.slice(-LOG_LIMIT) } as any;
      await prisma.syncState.upsert({
        where: { key: KDS_ACTION_LOG_KEY },
        create: { key: KDS_ACTION_LOG_KEY, valueJson },
        update: { valueJson },
      });
    } catch (e) {
      console.warn('[kds] could not record action:', e);
    }
  };
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/** The kitchen action log, newest first. */
export async function listKdsActions(limit = 200): Promise<KdsActionEntry[]> {
  const row = await prisma.syncState
    .findUnique({ where: { key: KDS_ACTION_LOG_KEY } })
    .catch(() => null);
  const entries = (row?.valueJson as any)?.entries;
  const list = Array.isArray(entries) ? (entries as KdsActionEntry[]) : [];
  return list.slice(-Math.max(1, Math.min(LOG_LIMIT, limit))).reverse();
}
