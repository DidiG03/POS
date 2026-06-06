import type { SettingsDTO } from '@shared/ipc';
import {
  isVatEnabledFromSettings,
  resolveVatEnabledFromMeta,
} from '@shared/vatFromFiscal';
import { prisma } from '@db/client';
import { coreServices } from './core';
import type { ShiftClosePrintSummary } from '../print';
import { dispatchTicket, pickActiveReceiptProfile } from './printDispatcher';

export type { ShiftClosePrintSummary };

function paymentTotalFromPayload(
  p: any,
  settings: unknown,
): {
  subtotal: number;
  vat: number;
  total: number;
  method: string;
} {
  const meta = (p?.meta as any) || {};
  const items = Array.isArray(p?.items) ? p.items : [];
  const subtotal = items.reduce(
    (s: number, it: any) => s + Number(it.unitPrice || 0) * Number(it.qty || 1),
    0,
  );
  const vatEnabled = resolveVatEnabledFromMeta(meta, settings);
  const vat = vatEnabled
    ? items.reduce(
        (s: number, it: any) =>
          s +
          Number(it.unitPrice || 0) *
            Number(it.qty || 1) *
            Number(it.vatRate || 0),
        0,
      )
    : 0;
  const serviceChargeAmount = Number(meta.serviceChargeAmount || 0);
  const discountAmount = Number(meta.discountAmount || 0);
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
  const method = String(meta.method || meta.paymentMethod || '')
    .trim()
    .toUpperCase();
  return { subtotal, vat, total, method };
}

export async function computeShiftPaidTotals(args: {
  userId: number;
  openedAt: Date;
  closedAt: Date;
}): Promise<ShiftClosePrintSummary> {
  const user = await prisma.user
    .findUnique({
      where: { id: args.userId },
      select: { displayName: true },
    })
    .catch(() => null);
  const settings = await coreServices.readSettings().catch(() => ({}));
  const fiscalVatEnabled = isVatEnabledFromSettings(settings);

  const jobs = await prisma.printJob
    .findMany({
      where: {
        type: 'RECEIPT' as any,
        attempts: 0,
        createdAt: { gte: args.openedAt, lte: args.closedAt },
      } as any,
      orderBy: { createdAt: 'asc' },
      take: 2000,
      select: { createdAt: true, payloadJson: true, attempts: true } as any,
    })
    .catch(
      () => [] as { createdAt: Date; payloadJson: any; attempts?: number }[],
    );

  let revenueNet = 0;
  let revenueVat = 0;
  let revenueGross = 0;
  let orders = 0;
  const byMethod = new Map<string, number>();

  for (const j of jobs) {
    if (Number((j as any)?.attempts || 0) > 0) continue;
    const p = (j.payloadJson as any) || {};
    const meta = (p?.meta as any) || {};
    if (String(meta?.kind || '') !== 'PAYMENT') continue;
    if (Number(meta?.userId || 0) !== Number(args.userId)) continue;

    const { subtotal, vat, total, method } = paymentTotalFromPayload(
      p,
      settings,
    );
    revenueNet += subtotal;
    revenueVat += vat;
    revenueGross += total;
    orders += 1;
    if (method) {
      byMethod.set(method, (byMethod.get(method) || 0) + total);
    }
  }

  return {
    waiterName: String(user?.displayName || `#${args.userId}`),
    openedAtIso: args.openedAt.toISOString(),
    closedAtIso: args.closedAt.toISOString(),
    orders,
    revenueNet,
    revenueVat,
    revenueGross,
    vatEnabled: fiscalVatEnabled,
    byMethod: Array.from(byMethod.entries()).map(([method, amount]) => ({
      method,
      amount,
    })),
  };
}

/** Print shift-close slip on the receipt printer; never throws. */
export async function printShiftCloseReceipt(
  summary: ShiftClosePrintSummary,
  settings: SettingsDTO,
): Promise<void> {
  try {
    if (!pickActiveReceiptProfile(settings)) return;
    await dispatchTicket(
      {
        area: 'SHIFT',
        tableLabel: 'CLOSE',
        items: [{ name: 'Shift report', qty: 1, unitPrice: 0 }],
        printedAtIso: summary.closedAtIso,
        userName: summary.waiterName,
        meta: { kind: 'SHIFT_CLOSE', shiftSummary: summary },
      },
      settings,
      { persistRetryOnTransientFailure: true },
    );
  } catch (e) {
    console.warn('[shiftSummary] print failed:', e);
  }
}

/**
 * After a shift row is closed: persist totals and print the summary slip.
 * Safe to call without awaiting from IPC handlers.
 */
export async function finalizeShiftAfterClockOut(args: {
  shiftId: number;
  userId: number;
  openedAt: Date;
  closedAt: Date;
}): Promise<ShiftClosePrintSummary> {
  const summary = await computeShiftPaidTotals({
    userId: args.userId,
    openedAt: args.openedAt,
    closedAt: args.closedAt,
  });
  await prisma.dayShift
    .update({
      where: { id: args.shiftId },
      data: { totalsJson: summary as any },
    })
    .catch(() => {});
  const settings = (await coreServices
    .readSettings()
    .catch(() => ({}))) as SettingsDTO;
  await printShiftCloseReceipt(summary, settings);
  return summary;
}
