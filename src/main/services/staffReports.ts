/**
 * Staff-facing "my tickets" queries shared by Electron IPC and the LAN API.
 *
 * Tablets used to call `/reports/my/active-tickets` (and paid/voided) after
 * opening Reports, but those routes were never registered on the host HTTP
 * API. The LAN policy then denied them as unknown, which is the same class
 * of miss that bounced waiters back to the PIN screen.
 */

import { prisma } from '@db/client';
import { coreServices } from './core';
import { isTransferredOutNote } from './tableTransfer';
import { listOccupiedTables } from './tableOccupancy';
import { ticketCreatedAtIso } from '@shared/ticketLogItems';
import {
  effectiveVatRate,
  latestRowPerSession,
  splitGrossVat,
  sumTicketLinesNetVat,
} from '@shared/ticketRevenue';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';

export async function listMyActiveTickets(userId: number): Promise<any[]> {
  if (!userId) return [];
  const occupied = await listOccupiedTables();
  const activeSettings = await coreServices.readSettings().catch(() => ({}));
  const activeVatEnabled = isVatEnabledFromSettings(activeSettings);

  const tickets = await Promise.all(
    occupied.map(async (t) => {
      const { area, label: tableLabel } = t;
      const since = t.openedAt;
      const ownerWhere: any = { area, tableLabel };
      if (since) ownerWhere.createdAt = { gte: since };
      const last = await prisma.ticketLog
        .findFirst({
          where: ownerWhere,
          orderBy: { createdAt: 'desc' },
        })
        .catch(() => null);
      if (!last || Number(last.userId) !== Number(userId)) return null;
      const where: any = { area, tableLabel };
      if (since) where.createdAt = { gte: since };
      const [rows, coversRow, u] = await Promise.all([
        prisma.ticketLog
          .findMany({ where, orderBy: { createdAt: 'asc' }, take: 500 })
          .catch(() => [] as any[]),
        prisma.covers
          .findFirst({
            where: {
              area,
              label: tableLabel,
              ...(since ? { createdAt: { gte: since } as any } : {}),
            },
            orderBy: { id: 'desc' },
          } as any)
          .catch(() => null),
        prisma.user
          .findUnique({ where: { id: last.userId } })
          .catch(() => null),
      ]);
      // Each row is a full snapshot of the check, not the lines added by that
      // send, so flattening them would show every earlier round twice.
      const itemsAll = latestRowPerSession(rows as any[]).flatMap((r: any) =>
        Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [],
      );
      const items = itemsAll.filter((it: any) => !it?.voided);
      const { net: subtotal, vat } = sumTicketLinesNetVat(
        items,
        activeVatEnabled,
        Number((activeSettings as any)?.defaultVatRate || 0),
      );
      return {
        kind: 'ACTIVE',
        area,
        tableLabel,
        createdAt: since ? since.toISOString() : last.createdAt.toISOString(),
        paidAt: null,
        covers: coversRow?.covers ?? last.covers ?? null,
        note: rows.find((r: any) => r.note)?.note ?? last.note ?? null,
        userName: u?.displayName ?? null,
        paymentMethod: null,
        vatEnabled: activeVatEnabled,
        items,
        subtotal,
        vat,
        total: subtotal + vat,
      } as any;
    }),
  );

  return (tickets.filter(Boolean) as any[]).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
}

export async function listMyPaidTickets(
  userId: number,
  qRaw?: string,
  limitRaw?: number,
): Promise<any[]> {
  const q = String(qRaw || '')
    .trim()
    .toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(limitRaw || 40)));
  if (!userId) return [];

  const take = q ? Math.max(limit, 500) : limit;
  const sales = await prisma.order
    .findMany({
      where: { status: 'PAID' as any, userId } as any,
      orderBy: { closedAt: 'desc' },
      take,
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' }, take: 1 },
        user: { select: { displayName: true } },
      },
    })
    .catch(() => []);

  const out: any[] = [];
  for (const sale of sales as any[]) {
    const pay = sale.payments?.[0] || null;
    const meta = (pay?.metaJson as any) || {};
    const area = String(sale.area || '');
    const tableLabel = String(sale.tableLabel || '');
    // Lines struck off by a corrective invoice are no longer on the bill.
    const items = Array.isArray(sale.items)
      ? sale.items
          .filter((it: any) => it?.voidedAt == null)
          .map((it: any) => ({
            sku: it.sku,
            name: it.name,
            qty: Number(it.qty || 0),
            unitPrice: Number(it.unitPrice || 0),
            vatRate: Number(it.vatRate || 0),
            note: it.note ?? null,
            station: it.station ?? null,
            categoryName: it.categoryName ?? null,
            courseId: it.courseId ?? null,
            seatId: it.seatId ?? null,
          }))
      : [];
    const userName =
      String(sale.userName || sale.user?.displayName || '').trim() || null;
    const paidAtRaw = sale.closedAt || pay?.paidAt || sale.createdAt;
    const paidAt =
      paidAtRaw instanceof Date
        ? paidAtRaw.toISOString()
        : new Date(paidAtRaw).toISOString();
    const createdAt = paidAt;
    const hay =
      `${area} ${tableLabel} ${String(userName || '')} ${items.map((it: any) => it.name).join(' ')}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const serviceChargeAmount = Number(
      sale.serviceChargeAmount ?? meta.serviceChargeAmount ?? 0,
    );
    const discountAmount = Number(
      sale.discountAmount ?? meta.discountAmount ?? 0,
    );
    const fiscalNslf =
      String(pay?.fiscalNslf || meta.fiscalNslf || '').trim() || null;
    const fiscalNivf =
      String(pay?.fiscalNivf || meta.fiscalNivf || '').trim() || null;
    const fiscalEic =
      String(pay?.fiscalEic || meta.fiscalEic || '').trim() || null;
    const fiscalLink = String(meta.fiscalLink || '').trim() || null;
    const fiscalQrCode = String(meta.fiscalQrCode || '').trim() || null;
    const fiscalTin = String(meta.fiscalTin || '').trim() || null;
    const fiscalStatus = String(meta.fiscalStatus || '').trim() || null;
    const fiscalWarning = String(meta.fiscalWarning || '').trim() || null;
    const fiscalEnabled =
      meta.fiscalEnabled === true ||
      Boolean(fiscalNivf) ||
      Boolean(fiscalNslf) ||
      String(fiscalStatus || '').toLowerCase() === 'pending';
    out.push({
      kind: 'PAID',
      area,
      tableLabel,
      createdAt,
      paidAt,
      covers: sale.covers ?? null,
      note: sale.note ?? null,
      userName,
      paymentMethod: pay?.method ?? meta.method ?? null,
      vatEnabled: Boolean(sale.vatEnabled),
      serviceChargeEnabled: (meta.serviceChargeEnabled ?? null) as any,
      serviceChargeApplied: (meta.serviceChargeApplied ?? null) as any,
      serviceChargeMode: (meta.serviceChargeMode ?? null) as any,
      serviceChargeValue: (meta.serviceChargeValue ?? null) as any,
      serviceChargeAmount: Number.isFinite(serviceChargeAmount)
        ? serviceChargeAmount
        : null,
      discountType: sale.discountType ?? meta.discountType ?? null,
      discountValue: (meta.discountValue ?? null) as any,
      discountAmount: Number.isFinite(discountAmount) ? discountAmount : null,
      discountReason: sale.discountReason ?? meta.discountReason ?? null,
      fiscalEnabled,
      fiscalNslf,
      fiscalNivf,
      fiscalEic,
      fiscalLink,
      fiscalQrCode,
      fiscalTin,
      fiscalStatus,
      fiscalWarning,
      items,
      subtotal: Number(sale.subtotal || 0),
      vat: Number(sale.vatAmount || 0),
      total: Number(sale.total || 0),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function listMyVoidedTickets(
  userId: number,
  limitRaw?: number,
): Promise<any[]> {
  const limit = Math.min(200, Math.max(1, Number(limitRaw || 40)));
  if (!userId) return [];

  const take = Math.min(500, Math.max(limit * 6, 120));
  const [rows, u] = await Promise.all([
    prisma.ticketLog
      .findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take,
      })
      .catch(() => []),
    prisma.user.findUnique({ where: { id: userId } }).catch(() => null),
  ]);

  const voidSettings = await coreServices.readSettings().catch(() => ({}));
  const voidVatEnabled = isVatEnabledFromSettings(voidSettings);
  const voidDefaultVatRate = Number((voidSettings as any)?.defaultVatRate || 0);

  const out: any[] = [];
  // Snapshots repeat every line of the check, so a single voided dish appears
  // on each row written after it — report the sitting once.
  for (const r of latestRowPerSession(rows as any[])) {
    if (Number(r.userId) !== Number(userId)) continue;
    if (isTransferredOutNote(r.note)) continue;
    const itemsAll = Array.isArray(r.itemsJson) ? (r.itemsJson as any[]) : [];
    const voidedItems = itemsAll.filter((it: any) => it?.voided === true);
    if (voidedItems.length === 0) continue;

    const note = String(r.note || '');
    const isFullVoid = itemsAll.every((it: any) => it?.voided === true);

    const grossSubtotal = voidedItems.reduce(
      (s: number, it: any) =>
        s + Number(it.unitPrice || 0) * Number(it.qty || 1),
      0,
    );
    const vat = voidVatEnabled
      ? voidedItems.reduce((s: number, it: any) => {
          const lineGross = Number(it.unitPrice || 0) * Number(it.qty || 1);
          const rate = effectiveVatRate(it.vatRate, voidDefaultVatRate);
          return s + splitGrossVat(lineGross, rate).vat;
        }, 0)
      : 0;
    const subtotal = grossSubtotal - vat;

    out.push({
      kind: isFullVoid ? 'VOIDED_TICKET' : 'VOIDED_ITEMS',
      area: r.area,
      tableLabel: r.tableLabel,
      createdAt: ticketCreatedAtIso(r.createdAt),
      note,
      userName: u?.displayName ?? null,
      covers: r.covers ?? null,
      items: voidedItems,
      totalItems: itemsAll.length,
      voidedCount: voidedItems.length,
      subtotal,
      vat,
      total: grossSubtotal,
    });
    if (out.length >= limit) break;
  }
  return out;
}
