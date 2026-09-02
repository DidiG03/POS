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
import {
  effectiveVatRate,
  latestRowPerSession,
  splitGrossVat,
  sumTicketLinesNetVat,
} from '@shared/ticketRevenue';
import {
  isVatEnabledFromSettings,
  resolveVatEnabledFromMeta,
} from '@shared/vatFromFiscal';

export async function listMyActiveTickets(userId: number): Promise<any[]> {
  if (!userId) return [];
  const [openRow, atRow] = await Promise.all([
    prisma.syncState
      .findUnique({ where: { key: 'tables:open' } })
      .catch(() => null),
    prisma.syncState
      .findUnique({ where: { key: 'tables:openAt' } })
      .catch(() => null),
  ]);
  const openMap = ((openRow?.valueJson as any) || {}) as Record<
    string,
    boolean
  >;
  const atMap = ((atRow?.valueJson as any) || {}) as Record<string, string>;
  const openKeys = Object.entries(openMap)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
  const activeSettings = await coreServices.readSettings().catch(() => ({}));
  const activeVatEnabled = isVatEnabledFromSettings(activeSettings);

  const tickets = await Promise.all(
    openKeys.map(async (k) => {
      const [area, tableLabel] = k.split(':');
      if (!area || !tableLabel) return null;
      const last = await prisma.ticketLog
        .findFirst({
          where: { area, tableLabel },
          orderBy: { createdAt: 'desc' },
        })
        .catch(() => null);
      if (!last || Number(last.userId) !== Number(userId)) return null;
      const sinceIso = atMap[k];
      const sinceParsed = sinceIso ? new Date(sinceIso) : null;
      const since =
        sinceParsed && Number.isFinite(sinceParsed.getTime())
          ? sinceParsed
          : null;
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

  const jobs = await prisma.printJob
    .findMany({
      where: { type: 'RECEIPT' as any, attempts: 0 } as any,
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    .catch(() => []);

  const paymentSettings = await coreServices.readSettings().catch(() => ({}));
  const out: any[] = [];
  for (const j of jobs as any[]) {
    const p = (j.payloadJson as any) || {};
    const meta = (p?.meta as any) || {};
    if (String(meta?.kind || '') !== 'PAYMENT') continue;
    if (Number(meta?.userId || 0) !== Number(userId)) continue;
    if (Number((j as any)?.attempts || 0) > 0) continue;
    const area = String(p.area || '');
    const tableLabel = String(p.tableLabel || '');
    const items = Array.isArray(p.items) ? p.items : [];
    const note = p.note ?? null;
    const covers = (p.covers ?? null) as any;
    const userName = p.userName ?? null;
    const paymentMethod = (meta.method ?? null) as any;
    const paidAt = meta.paidAt ?? j.createdAt.toISOString();
    const vatEnabled = resolveVatEnabledFromMeta(meta, paymentSettings);
    const { net: subtotal, vat } = sumTicketLinesNetVat(
      items,
      vatEnabled,
      Number((paymentSettings as any)?.defaultVatRate || 0),
    );
    const serviceChargeEnabled = (meta.serviceChargeEnabled ?? null) as any;
    const serviceChargeApplied = (meta.serviceChargeApplied ?? null) as any;
    const serviceChargeMode = (meta.serviceChargeMode ?? null) as any;
    const serviceChargeValue = (meta.serviceChargeValue ?? null) as any;
    const serviceChargeAmount = Number(meta.serviceChargeAmount || 0);
    const discountType = (meta.discountType ?? null) as any;
    const discountValue = (meta.discountValue ?? null) as any;
    const discountAmount = Number(meta.discountAmount || 0);
    const discountReason = (meta.discountReason ?? null) as any;
    const fallbackTotal = Math.max(
      0,
      subtotal +
        vat +
        (Number.isFinite(serviceChargeAmount) ? serviceChargeAmount : 0) -
        (Number.isFinite(discountAmount) ? discountAmount : 0),
    );
    const totalAfter = Number(meta.totalAfter);
    const total = Number.isFinite(totalAfter)
      ? Math.max(0, totalAfter)
      : fallbackTotal;
    const hay =
      `${area} ${tableLabel} ${String(userName || '')} ${items.map((it: any) => it.name).join(' ')}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    out.push({
      kind: 'PAID',
      area,
      tableLabel,
      createdAt: j.createdAt.toISOString(),
      paidAt,
      covers,
      note,
      userName,
      paymentMethod,
      vatEnabled,
      serviceChargeEnabled,
      serviceChargeApplied,
      serviceChargeMode,
      serviceChargeValue,
      serviceChargeAmount: Number.isFinite(serviceChargeAmount)
        ? serviceChargeAmount
        : null,
      discountType,
      discountValue,
      discountAmount: Number.isFinite(discountAmount) ? discountAmount : null,
      discountReason,
      items,
      subtotal,
      vat,
      total,
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

  const rows = await prisma.ticketLog
    .findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    .catch(() => []);

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
    const u = await prisma.user
      .findUnique({ where: { id: r.userId } })
      .catch(() => null);

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
      createdAt: r.createdAt.toISOString(),
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
