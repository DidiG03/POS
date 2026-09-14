import { prisma } from '@db/client';
import { asTicketLogItems, rowIsInOpenSession } from '@shared/ticketLogItems';
import { dayBounds } from './reservations';
import {
  findLatestTicketLogSince,
  getTableSessionStartedAt,
} from './tableSession';
import { isTableOccupied } from './tableOccupancy';

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
  const sales = await prisma.order
    .findMany({
      where: {
        status: 'PAID' as any,
        closedAt: { gte: start, lte: end },
      } as any,
      orderBy: { closedAt: 'desc' },
      select: { area: true, tableLabel: true, closedAt: true } as any,
    })
    .catch(() => []);
  const latest = new Map<string, PaidPosTable>();
  for (const sale of sales as {
    area?: string;
    tableLabel?: string;
    closedAt?: Date | string | null;
  }[]) {
    const area = String(sale.area || '').trim();
    const label = String(sale.tableLabel || '').trim();
    if (!area || !label) continue;
    const key = `${area}:${label}`;
    if (latest.has(key)) continue;
    const paidAtRaw = sale.closedAt;
    const paidAt =
      paidAtRaw instanceof Date
        ? paidAtRaw.toISOString()
        : new Date(paidAtRaw as any).toISOString();
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
  if (!(await isTableOccupied(area, tableLabel))) return null;

  const since = await getTableSessionStartedAt(area, tableLabel);
  const [last, coverRows] = await Promise.all([
    findLatestTicketLogSince(area, tableLabel, since),
    prisma.covers.findMany({
      where: { area, label: tableLabel },
      orderBy: { id: 'desc' },
      take: 20,
    }),
  ]);
  const coversRow = since
    ? coverRows.find((row) =>
        rowIsInOpenSession(row.createdAt, since.getTime()),
      )
    : coverRows[0];
  const items = asTicketLogItems(last?.itemsJson).filter(
    (it: any) => !it?.voided,
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
