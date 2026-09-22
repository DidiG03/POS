/**
 * Sales ledger: Order + OrderItem + Payment written at settlement.
 *
 * PrintJob remains the printer instruction / retry queue. TicketLog remains
 * the kitchen snapshot. Revenue reports must read Order, not PrintJob JSON.
 */

import { prisma } from '@db/client';
import { coreServices } from './core';
import { roundMoney } from '@shared/pricing';
import {
  cashChangeDue,
  isPaymentPayload,
  ledgerLinesFromPayload,
  orderTypeFromArea,
  parsePaidAt,
  saleFiguresFromPayload,
} from '@shared/salesLedger';
import {
  consumeMenuStockForTicketLines,
  stockLinesFromTicketItems,
} from './menuStock';
import { storePlanBlocksTables } from './license';
import { isPaymentReprint } from './paymentSettle';

type Db = {
  order: any;
  user: any;
  table: any;
  menuItem: any;
  printJob: any;
  $transaction?: any;
};

export type PersistReceiptAuditResult = {
  duplicate: boolean;
  printJobId: number | null;
  orderId: number | null;
};

function money(n: number): string {
  return roundMoney(n).toFixed(2);
}

function optionalKey(raw: unknown): string | undefined {
  const s = String(raw || '').trim();
  return s || undefined;
}

export async function writeSettledSale(
  db: Db,
  args: {
    payload: any;
    idempotencyKey?: string | null;
    printJobId?: number | null;
    paidAt?: Date;
    settings?: unknown;
  },
): Promise<{ orderId: number; created: boolean } | null> {
  if (!isPaymentPayload(args.payload)) return null;
  const payload = args.payload || {};
  const meta = (payload.meta as any) || {};
  // Reports "Print ticket" sends kind=PAYMENT with reprint=true so the
  // guest slip routes to the receipt printer. That must not create a
  // second Order — paid tickets in Reports are listed from Order rows.
  if (isPaymentReprint(meta)) return null;
  const key = optionalKey(args.idempotencyKey);
  const printJobId =
    Number(args.printJobId) > 0 ? Math.floor(Number(args.printJobId)) : null;

  if (key) {
    const byKey = await db.order
      .findFirst({
        where: { idempotencyKey: key },
        select: { id: true, printJobId: true },
      })
      .catch(() => null);
    if (byKey?.id) {
      if (printJobId && !byKey.printJobId) {
        await db.order
          .update({
            where: { id: byKey.id },
            data: { printJobId } as any,
          })
          .catch(() => {});
      }
      return { orderId: byKey.id, created: false };
    }
  }
  if (printJobId) {
    const byJob = await db.order
      .findFirst({
        where: { printJobId },
        select: { id: true },
      })
      .catch(() => null);
    if (byJob?.id) return { orderId: byJob.id, created: false };
  }

  const lines = ledgerLinesFromPayload(payload);
  if (lines.length === 0) return null;

  const figures = saleFiguresFromPayload(payload, args.settings);
  const paidAt = parsePaidAt(meta.paidAt, args.paidAt || new Date());
  const area = String(payload.area || '');
  const tableLabel = String(payload.tableLabel || '');

  let userId: number | null = Number(meta.userId || 0) || null;
  let userName = String(payload.userName || '').trim() || null;
  if (userId) {
    const user = await db.user
      .findUnique({
        where: { id: userId },
        select: { id: true, displayName: true },
      })
      .catch(() => null);
    if (!user) userId = null;
    else if (!userName)
      userName = String(user.displayName || '').trim() || null;
  }

  let tableId: number | null = null;
  if (area && tableLabel) {
    const table = await db.table
      .findFirst({
        where: { area, label: tableLabel },
        select: { id: true },
      })
      .catch(() => null);
    if (table?.id) tableId = Number(table.id);
  }

  const skus = [
    ...new Set(lines.map((l) => String(l.sku || '').trim()).filter(Boolean)),
  ];
  const menuRows =
    skus.length > 0
      ? ((await db.menuItem
          .findMany({
            where: { sku: { in: skus } },
            select: { id: true, sku: true },
          })
          .catch(() => [])) as { id: number; sku: string }[])
      : [];
  const menuBySku = new Map(menuRows.map((m) => [m.sku, m.id]));

  const coversRaw = Number(payload.covers);
  const covers =
    Number.isFinite(coversRaw) && coversRaw > 0 ? Math.floor(coversRaw) : null;
  const change = cashChangeDue(meta.amountPaid, figures.total);
  const seatId = String(meta.seatId || lines[0]?.seatId || '').trim() || null;
  const seatLabel = String(meta.seatLabel || '').trim() || null;
  const discountType = String(meta.discountType || '').trim() || null;
  const discountReason = String(meta.discountReason || '').trim() || null;

  try {
    const created = await db.order.create({
      data: {
        type: orderTypeFromArea(area),
        status: 'PAID',
        tableId,
        userId,
        openedAt: paidAt,
        closedAt: paidAt,
        area,
        tableLabel,
        covers,
        note: payload.note ? String(payload.note) : null,
        userName,
        idempotencyKey: key,
        printJobId,
        seatId,
        seatLabel,
        subtotal: money(figures.subtotal),
        vatAmount: money(figures.vat),
        discountAmount: money(figures.discountAmount),
        discountType,
        discountReason,
        serviceChargeAmount: money(figures.serviceChargeAmount),
        total: money(figures.total),
        vatEnabled: figures.vatEnabled,
        items: {
          create: lines.map((l, i) => ({
            menuItemId: l.sku
              ? (menuBySku.get(String(l.sku).trim()) ?? null)
              : null,
            sku: String(l.sku || ''),
            name: String(l.name || '').trim() || 'Item',
            qty: money(Number(l.qty || 0)),
            unitPrice: money(Number(l.unitPrice || 0)),
            vatRate: money(Number(l.vatRate || 0)),
            note: l.note ? String(l.note) : null,
            station: l.station ? String(l.station) : null,
            categoryName: l.categoryName ? String(l.categoryName) : null,
            courseId: l.courseId ? String(l.courseId) : null,
            seatId: l.seatId ? String(l.seatId) : null,
            sortOrder: i,
          })),
        },
        payments: {
          create: {
            method: figures.method,
            amount: money(figures.total),
            tip: money(0),
            change: money(change),
            paidAt,
            idempotencyKey: key,
            fiscalNslf: String(meta.fiscalNslf || '').trim() || null,
            fiscalNivf: String(meta.fiscalNivf || '').trim() || null,
            metaJson: meta,
          },
        },
      } as any,
      select: { id: true },
    });
    return { orderId: Number(created.id), created: true };
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const again = key
        ? await db.order
            .findFirst({
              where: { idempotencyKey: key },
              select: { id: true },
            })
            .catch(() => null)
        : printJobId
          ? await db.order
              .findFirst({
                where: { printJobId },
                select: { id: true },
              })
              .catch(() => null)
          : null;
      if (again?.id) return { orderId: again.id, created: false };
    }
    throw e;
  }
}

/**
 * Persist the receipt PrintJob and, for PAYMENT, the sales ledger row
 * in one transaction so a printer retry cannot create a second sale.
 */
export async function persistReceiptAudit(input: {
  payload: any;
  idempotencyKey?: string;
  status: 'SENT' | 'FAILED';
  settings?: unknown;
}): Promise<PersistReceiptAuditResult> {
  const key = optionalKey(input.idempotencyKey);
  const settings =
    input.settings !== undefined
      ? input.settings
      : await coreServices.readSettings().catch(() => ({}));
  try {
    const result = await (prisma as any).$transaction(async (tx: Db) => {
      const job = await tx.printJob.create({
        data: {
          type: 'RECEIPT',
          payloadJson: input.payload,
          status: input.status,
          ...(key ? { idempotencyKey: key } : {}),
        } as any,
      });
      const sale = await writeSettledSale(tx, {
        payload: input.payload,
        idempotencyKey: key,
        printJobId: Number(job.id),
        paidAt: job.createdAt instanceof Date ? job.createdAt : new Date(),
        settings,
      });
      if (
        isPaymentPayload(input.payload) &&
        !isPaymentReprint(input.payload?.meta) &&
        storePlanBlocksTables()
      ) {
        await consumeMenuStockForTicketLines(
          tx as Parameters<typeof consumeMenuStockForTicketLines>[0],
          stockLinesFromTicketItems(input.payload?.items),
          'onHand',
        );
      }
      return {
        duplicate: false,
        printJobId: Number(job.id),
        orderId: sale?.orderId ?? null,
      } as PersistReceiptAuditResult;
    });
    return result;
  } catch (e: any) {
    if (e?.code === 'P2002' && key) {
      const existing = await (prisma as any).printJob
        .findFirst({
          where: { idempotencyKey: key },
          select: {
            id: true,
            payloadJson: true,
            createdAt: true,
            idempotencyKey: true,
            attempts: true,
          },
        })
        .catch(() => null);
      const sale = existing
        ? await ensureSettledSaleFromPrintJob(existing, settings)
        : await writeSettledSale(prisma as any, {
            payload: input.payload,
            idempotencyKey: key,
            settings,
          });
      return {
        duplicate: true,
        printJobId: existing?.id ? Number(existing.id) : null,
        orderId: sale?.orderId ?? null,
      };
    }
    throw e;
  }
}

export async function ensureSettledSaleFromPrintJob(
  job: {
    id: number;
    payloadJson?: any;
    createdAt?: Date;
    idempotencyKey?: string | null;
    attempts?: number | null;
  },
  settings?: unknown,
): Promise<{ orderId: number; created: boolean } | null> {
  if (Number(job?.attempts || 0) > 0) return null;
  const payload = job?.payloadJson;
  if (!isPaymentPayload(payload)) return null;
  return writeSettledSale(prisma as any, {
    payload,
    printJobId: job.id,
    idempotencyKey: job.idempotencyKey,
    paidAt: job.createdAt,
    settings:
      settings !== undefined
        ? settings
        : await coreServices.readSettings().catch(() => ({})),
  });
}

/** Replay PAYMENT PrintJobs that never got an Order row (upgrades + crash repair). */
export async function backfillSalesLedgerFromPrintJobs(opts?: {
  batchSize?: number;
}): Promise<{ scanned: number; written: number }> {
  const batchSize = Math.min(500, Math.max(50, Number(opts?.batchSize || 200)));
  const settings = await coreServices.readSettings().catch(() => ({}));
  let cursor: number | undefined;
  let scanned = 0;
  let written = 0;
  for (;;) {
    const jobs = await (prisma as any).printJob.findMany({
      where: {
        type: 'RECEIPT',
        attempts: 0,
        ...(cursor ? { id: { gt: cursor } } : {}),
      } as any,
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        payloadJson: true,
        createdAt: true,
        idempotencyKey: true,
        attempts: true,
      } as any,
    });
    if (!jobs.length) break;
    scanned += jobs.length;
    cursor = Number(jobs[jobs.length - 1].id);
    const ids = jobs.map((j: any) => Number(j.id));
    const existing = await (prisma as any).order.findMany({
      where: { printJobId: { in: ids } },
      select: { printJobId: true },
    });
    const have = new Set(
      (existing as any[]).map((o) => Number(o.printJobId)).filter((n) => n > 0),
    );
    for (const job of jobs as any[]) {
      if (have.has(Number(job.id))) continue;
      if (!isPaymentPayload(job.payloadJson)) continue;
      try {
        const r = await writeSettledSale(prisma as any, {
          payload: job.payloadJson,
          printJobId: Number(job.id),
          idempotencyKey: job.idempotencyKey,
          paidAt: job.createdAt,
          settings,
        });
        if (r?.created) written += 1;
      } catch (e) {
        console.warn(`[salesLedger] backfill skipped printJob #${job.id}:`, e);
      }
    }
  }
  return { scanned, written };
}
