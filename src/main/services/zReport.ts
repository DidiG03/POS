/**
 * Z report: the end-of-day close (QA v0.2.103, fiscal compliance).
 *
 * The till had no end-of-day report. A Z report now:
 *   - covers from where the previous Z ended up to now, so running it at
 *     any time never misses a sale or counts one twice (the first Z starts
 *     at the beginning of that day);
 *   - is numbered in sequence and stored on the till; a reprint prints the
 *     stored report marked KOPJE / COPY and never recomputes or renumbers;
 *   - states the sales, by payment method and VAT rate, what was filed with
 *     the tax office and what was not yet, corrections, voids, and the cash
 *     drawer (opening float, cash sales, cash in/out, cash expected).
 *
 * easyPos has no day-close route, so nothing is sent to the tax service.
 */
import { prisma } from '@db/client';
import { KeyedAsyncMutex } from '@shared/asyncMutex';
import { roundMoney } from '@shared/money';
import { effectiveVatRate, splitGrossVat } from '@shared/ticketRevenue';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import { coreServices } from './core';
import { countVoidedTickets, fetchPaidSales } from './paidAnalytics';
import { listCashDeclarations } from './fiscal/cashDrawer';
import { readDailyBalanceRecord } from './fiscal/balance';
import {
  listFiscalClaimsDeferred,
  listFiscalClaimsNeedingReview,
} from './fiscal/claims';

const LAST_KEY = 'z:last';
const recordKey = (n: number) => `z:report:${n}`;
const KEEP_LISTED = 60;

export type ZReport = {
  number: number;
  /** Covered period, ISO. */
  from: string;
  to: string;
  issuedAt: string;
  issuedByUserId: number | null;
  currency: string;
  vatEnabled: boolean;
  fiscalEnabled: boolean;
  sales: { count: number; net: number; vat: number; gross: number };
  byMethod: Array<{ method: string; count: number; amount: number }>;
  /** Items by VAT rate, before bill-level discounts and service. */
  byVatRate: Array<{ rate: number; net: number; vat: number; gross: number }>;
  fiscal: {
    filedCount: number;
    filedAmount: number;
    notFiledCount: number;
    notFiledAmount: number;
    /** Across all days, at the time of the report. */
    queued: number;
    waitingForReview: number;
  };
  corrections: { count: number; cancellations: number; amount: number };
  voidedTickets: number;
  cash: {
    opening: number | null;
    sales: number;
    deposits: number;
    withdrawals: number;
    expected: number | null;
  };
};

type Stored = { number: number; to: string };

async function readJson<T>(key: string): Promise<T | null> {
  const row = await prisma.syncState
    .findUnique({ where: { key } })
    .catch(() => null);
  return ((row as any)?.valueJson as T) ?? null;
}

async function writeJson(key: string, valueJson: unknown): Promise<void> {
  await prisma.syncState.upsert({
    where: { key },
    create: { key, valueJson: valueJson as any },
    update: { valueJson: valueJson as any },
  });
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The figures for `[from, to]`. Pure read: no number, nothing stored. */
export async function computeZReport(input: {
  from: Date;
  to: Date;
  settings?: unknown;
}): Promise<Omit<ZReport, 'number' | 'issuedAt' | 'issuedByUserId'>> {
  const settings: any =
    input.settings ?? (await coreServices.readSettings().catch(() => ({})));
  const vatEnabled = isVatEnabledFromSettings(settings);
  const fiscalEnabled = settings?.fiscal?.enabled === true;
  const defaultVatRate = Number(settings?.defaultVatRate || 0);
  const { from, to } = input;

  const sales = await fetchPaidSales({ from, to });
  const totals = { count: sales.length, net: 0, vat: 0, gross: 0 };
  const methods = new Map<string, { count: number; amount: number }>();
  for (const s of sales) {
    totals.net += s.subtotal;
    totals.vat += s.vatAmount;
    totals.gross += s.total;
    const m = methods.get(s.paymentMethod) ?? { count: 0, amount: 0 };
    m.count += 1;
    m.amount += s.total;
    methods.set(s.paymentMethod, m);
  }

  const orderIds = sales
    .map((s) => Number(s.orderId))
    .filter((n) => Number.isInteger(n) && n > 0);
  const filedOrders = new Set<number>();
  const rates = new Map<number, number>();
  for (const ids of chunks(orderIds, 500)) {
    const payments = (await prisma.payment
      .findMany({
        where: { orderId: { in: ids } } as any,
        select: { orderId: true, fiscalNivf: true } as any,
      })
      .catch(() => [])) as Array<{ orderId: number; fiscalNivf?: string }>;
    for (const p of payments) {
      if (String(p.fiscalNivf || '').trim()) filedOrders.add(Number(p.orderId));
    }
    if (vatEnabled) {
      const lines = (await prisma.orderItem
        .findMany({
          where: { orderId: { in: ids }, voidedAt: null } as any,
          select: { qty: true, unitPrice: true, vatRate: true } as any,
        })
        .catch(() => [])) as Array<{
        qty: unknown;
        unitPrice: unknown;
        vatRate: unknown;
      }>;
      for (const l of lines) {
        const gross = Number(l.qty) * Number(l.unitPrice);
        if (!Number.isFinite(gross)) continue;
        const rate = effectiveVatRate(l.vatRate, defaultVatRate);
        rates.set(rate, (rates.get(rate) ?? 0) + gross);
      }
    }
  }
  let filedAmount = 0;
  let notFiledAmount = 0;
  let filedCount = 0;
  for (const s of sales) {
    if (s.orderId && filedOrders.has(Number(s.orderId))) {
      filedCount += 1;
      filedAmount += s.total;
    } else {
      notFiledAmount += s.total;
    }
  }

  const corrections = (await prisma.saleCorrection
    .findMany({
      where: { createdAt: { gte: from, lte: to } } as any,
      select: { kind: true, amountDelta: true } as any,
    })
    .catch(() => [])) as Array<{ kind: string; amountDelta: unknown }>;

  const [voidedTickets, queued, review, declarations, opening] =
    await Promise.all([
      countVoidedTickets(from, to).catch(() => 0),
      fiscalEnabled
        ? listFiscalClaimsDeferred()
            .then((r) => r.length)
            .catch(() => 0)
        : Promise.resolve(0),
      fiscalEnabled
        ? listFiscalClaimsNeedingReview()
            .then((r) => r.length)
            .catch(() => 0)
        : Promise.resolve(0),
      listCashDeclarations().catch(() => []),
      fiscalEnabled
        ? readDailyBalanceRecord(settings).catch(() => null)
        : Promise.resolve(null),
    ]);
  const inPeriod = declarations.filter((d) => {
    const at = Date.parse(d.at);
    return d.ok && at >= from.getTime() && at <= to.getTime();
  });
  const sum = (kind: string) =>
    roundMoney(
      inPeriod
        .filter((d) => d.kind === kind)
        .reduce((a, d) => a + Number(d.amount || 0), 0),
    );
  const declaredOpening =
    opening?.state === 'COMPLETE' ? Number(opening.amount) : null;
  const cashSales = roundMoney(methods.get('CASH')?.amount ?? 0);
  const deposits = sum('deposit');
  const withdrawals = sum('withdraw');

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    currency: String(settings?.currency || 'EUR'),
    vatEnabled,
    fiscalEnabled,
    sales: {
      count: totals.count,
      net: roundMoney(totals.net),
      vat: roundMoney(totals.vat),
      gross: roundMoney(totals.gross),
    },
    byMethod: [...methods.entries()]
      .map(([method, m]) => ({
        method,
        count: m.count,
        amount: roundMoney(m.amount),
      }))
      .sort((a, b) => b.amount - a.amount),
    byVatRate: [...rates.entries()]
      .map(([rate, gross]) => {
        const split = splitGrossVat(gross, rate);
        return {
          rate,
          net: roundMoney(split.net),
          vat: roundMoney(split.vat),
          gross: roundMoney(gross),
        };
      })
      .sort((a, b) => b.rate - a.rate),
    fiscal: {
      filedCount,
      filedAmount: roundMoney(filedAmount),
      notFiledCount: fiscalEnabled ? totals.count - filedCount : 0,
      notFiledAmount: fiscalEnabled ? roundMoney(notFiledAmount) : 0,
      queued,
      waitingForReview: review,
    },
    corrections: {
      count: corrections.length,
      cancellations: corrections.filter(
        (c) => String(c.kind).toUpperCase() === 'CANCEL',
      ).length,
      amount: roundMoney(
        corrections.reduce((a, c) => a + Number(c.amountDelta || 0), 0),
      ),
    },
    voidedTickets,
    cash: {
      opening: declaredOpening,
      sales: cashSales,
      deposits,
      withdrawals,
      expected:
        declaredOpening == null
          ? null
          : roundMoney(declaredOpening + cashSales + deposits - withdrawals),
    },
  };
}

const zLock = new KeyedAsyncMutex();

/**
 * Close the period since the last Z: compute, number, store and print it.
 * One at a time, so two presses never make two reports for one period.
 */
export async function issueZReport(input: {
  actorUserId?: number | null;
  now?: Date;
  print?: (z: ZReport, copy: boolean) => Promise<boolean>;
}): Promise<{ report: ZReport; printed: boolean }> {
  return zLock.runExclusive('z', async () => {
    const last = await readJson<Stored>(LAST_KEY);
    const lastTo = last?.to ? new Date(last.to) : null;
    const hasLast = Boolean(lastTo && Number.isFinite(lastTo.getTime()));
    // Always from where the last Z ended, even when the clock has not moved
    // on (two presses in one millisecond): the period is then empty, never
    // the day again.
    const from = hasLast
      ? new Date(lastTo!.getTime() + 1)
      : startOfLocalDay(input.now ?? new Date());
    const asked = input.now ?? new Date();
    const now = asked.getTime() >= from.getTime() ? asked : from;
    const figures = await computeZReport({ from, to: now });
    const report: ZReport = {
      ...figures,
      number: (last?.number ?? 0) + 1,
      issuedAt: now.toISOString(),
      issuedByUserId: Number(input.actorUserId || 0) || null,
    };
    // The report is stored before it is printed: a printer problem never
    // loses a Z or lets the same period be closed twice.
    await writeJson(recordKey(report.number), report);
    await writeJson(LAST_KEY, { number: report.number, to: report.to });
    const printed = await (input.print ?? printZReport)(report, false).catch(
      () => false,
    );
    return { report, printed };
  });
}

export async function readZReport(n: number): Promise<ZReport | null> {
  return readJson<ZReport>(recordKey(Number(n)));
}

/** The latest Z reports, newest first. */
export async function listZReports(limit = 14): Promise<ZReport[]> {
  const last = await readJson<Stored>(LAST_KEY);
  const out: ZReport[] = [];
  for (
    let n = last?.number ?? 0;
    n > 0 && out.length < Math.min(limit, KEEP_LISTED);
    n--
  ) {
    const z = await readZReport(n);
    if (z) out.push(z);
  }
  return out;
}

/** Print a stored Z again, as a copy. Never recomputed. */
export async function reprintZReport(
  n: number,
  print: (z: ZReport, copy: boolean) => Promise<boolean> = printZReport,
): Promise<{ ok: boolean; printed?: boolean; error?: string }> {
  const z = await readZReport(n);
  if (!z) return { ok: false, error: `There is no Z report number ${n}.` };
  return { ok: true, printed: await print(z, true).catch(() => false) };
}

export async function printZReport(
  z: ZReport,
  copy: boolean,
): Promise<boolean> {
  const settings: any = await coreServices.readSettings();
  const { dispatchTicket, pickActiveReceiptProfile } = await import(
    './printDispatcher'
  );
  if (!pickActiveReceiptProfile(settings)) return false;
  const r = await dispatchTicket(
    {
      area: 'Z',
      tableLabel: String(z.number),
      items: [{ name: 'Z report', qty: 1, unitPrice: 0 }],
      printedAtIso: z.issuedAt,
      meta: {
        kind: 'Z_REPORT',
        zReport: z,
        ...(copy ? { reprint: true } : {}),
      },
    } as any,
    settings,
    { persistRetryOnTransientFailure: true },
  );
  return Boolean(r?.ok);
}
