import { prisma } from '@db/client';
import { dayBounds } from './reservations';

export type TableTooltip = {
  covers: number | null;
  firstAt: string | null;
  total: number;
};

export type PaidPosTable = {
  area: string;
  label: string;
  paidAt: string;
};

/**
 * Latest waiter PAYMENT receipt per table for the local day. Used by the
 * host floor/list to show a Paguar chip after the ticket is closed.
 */
export async function listPaidTablesForDay(
  dateIso: string,
): Promise<PaidPosTable[]> {
  if (!dateIso) return [];
  const { start, end } = dayBounds(dateIso);
  const jobs = await prisma.printJob
    .findMany({
      where: {
        type: 'RECEIPT' as any,
        attempts: 0,
        createdAt: { gte: start, lte: end },
      } as any,
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { createdAt: true, payloadJson: true, attempts: true } as any,
    })
    .catch(() => []);
  const latest = new Map<string, PaidPosTable>();
  for (const j of jobs as {
    createdAt: Date;
    payloadJson: any;
    attempts?: number;
  }[]) {
    if (Number(j?.attempts || 0) > 0) continue;
    const p = (j.payloadJson as any) || {};
    const meta = (p?.meta as any) || {};
    if (String(meta?.kind || '') !== 'PAYMENT') continue;
    const area = String(p.area || '').trim();
    const label = String(p.tableLabel || '').trim();
    if (!area || !label) continue;
    const key = `${area}:${label}`;
    if (latest.has(key)) continue;
    const paidAtRaw = meta.paidAt ?? j.createdAt;
    const paidAt =
      paidAtRaw instanceof Date
        ? paidAtRaw.toISOString()
        : new Date(paidAtRaw).toISOString();
    if (!Number.isFinite(Date.parse(paidAt))) continue;
    latest.set(key, { area, label, paidAt });
  }
  return [...latest.values()];
}

/**
 * Covers, session-start time, and running total for an open table.
 * Shared by Electron IPC (`tickets:getTableTooltip`) and LAN
 * (`GET /tickets/tooltip`) so the host floor and waiter tablets stay in sync.
 */
export async function getTableTooltip(
  area: string,
  tableLabel: string,
): Promise<TableTooltip | null> {
  if (!area || !tableLabel) return null;
  const openRow = await prisma.syncState.findUnique({
    where: { key: 'tables:open' },
  });
  const openMap = ((openRow?.valueJson as any) || {}) as Record<
    string,
    boolean
  >;
  const k = `${area}:${tableLabel}`;
  if (!openMap[k]) return null;

  const atRow = await prisma.syncState.findUnique({
    where: { key: 'tables:openAt' },
  });
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const sinceIso = atMap[k];
  const sinceParsed = sinceIso ? new Date(sinceIso) : null;
  const since =
    sinceParsed && Number.isFinite(sinceParsed.getTime()) ? sinceParsed : null;
  const where: any = { area, tableLabel };
  if (since) where.createdAt = { gte: since };
  const [last, coversRow] = await Promise.all([
    prisma.ticketLog.findFirst({ where, orderBy: { createdAt: 'desc' } }),
    prisma.covers.findFirst({
      where: {
        area,
        label: tableLabel,
        ...(since ? { createdAt: { gte: since } as any } : {}),
      },
      orderBy: { id: 'desc' },
    } as any),
  ]);
  const items = ((last?.itemsJson as any[]) || []).filter(
    (it: any) => !it.voided,
  );
  const total = items.reduce(
    (s: number, it: any) => s + Number(it.unitPrice || 0) * Number(it.qty || 1),
    0,
  );
  return {
    covers: coversRow?.covers ?? null,
    firstAt: since
      ? since.toISOString()
      : last
        ? new Date(last.createdAt).toISOString()
        : null,
    total,
  };
}
