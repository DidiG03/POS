import type { SettingsDTO } from '@shared/ipc';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import { prisma } from '@db/client';
import { coreServices } from './core';
import type { ShiftClosePrintSummary } from '../print';
import { dispatchTicket, pickActiveReceiptProfile } from './printDispatcher';

export type { ShiftClosePrintSummary };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

  const sales = await prisma.order
    .findMany({
      where: {
        status: 'PAID' as any,
        userId: args.userId,
        closedAt: { gte: args.openedAt, lte: args.closedAt },
      } as any,
      orderBy: { closedAt: 'asc' },
      include: { payments: { select: { method: true, amount: true } } },
    })
    .catch(() => []);

  let revenueNet = 0;
  let revenueVat = 0;
  let revenueGross = 0;
  let orders = 0;
  const byMethod = new Map<string, number>();

  for (const sale of sales as any[]) {
    const subtotal = num(sale.subtotal);
    const vat = num(sale.vatAmount);
    const total = num(sale.total);
    const method = String(sale.payments?.[0]?.method || '').toUpperCase();
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
): Promise<{ printed: boolean; error?: string }> {
  try {
    if (!pickActiveReceiptProfile(settings)) {
      return { printed: false, error: 'No printer configured' };
    }
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
    return { printed: true };
  } catch (e) {
    console.warn('[shiftSummary] print failed:', e);
    return {
      printed: false,
      error: String((e as Error)?.message || e || 'print failed'),
    };
  }
}

/**
 * Paid totals for this waiter's calendar day (or open shift if it started
 * today), printed as the same shift-summary slip used on clock-out.
 */
export async function printMyDaySummary(userId: number): Promise<{
  ok: boolean;
  error?: string;
  summary?: ShiftClosePrintSummary;
}> {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'no-user' };
  }
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const openShift = await prisma.dayShift
    .findFirst({
      where: { openedById: id, closedAt: null },
      orderBy: { openedAt: 'desc' },
      select: { openedAt: true },
    })
    .catch(() => null);
  const openedAt =
    openShift?.openedAt instanceof Date && openShift.openedAt >= dayStart
      ? openShift.openedAt
      : dayStart;
  const summary = await computeShiftPaidTotals({
    userId: id,
    openedAt,
    closedAt: now,
  });
  const settings = (await coreServices
    .readSettings()
    .catch(() => ({}))) as SettingsDTO;
  const printed = await printShiftCloseReceipt(summary, settings);
  if (!printed.printed) {
    return { ok: false, error: printed.error || 'print failed', summary };
  }
  return { ok: true, summary };
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
