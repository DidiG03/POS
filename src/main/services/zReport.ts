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
import { effectiveVatRate } from '@shared/ticketRevenue';
import { eurExchangeRateFromSettings } from '@shared/paymentDisplay';
import { isVatEnabledFromSettings } from '@shared/vatFromFiscal';
import { coreServices } from './core';
import { countVoidedTickets, fetchPaidSales } from './paidAnalytics';
import { countBillEventsBetween } from './billEvents';
import { listCashDeclarations } from './fiscal/cashDrawer';
import { readDailyBalanceRecord } from './fiscal/balance';
import { fiscalDayKeysBetween, startOfFiscalDay } from './fiscal/clock';
import {
  listFiscalClaimsDeferred,
  listFiscalClaimsNeedingReview,
} from './fiscal/claims';
import { logIgnored } from './logIgnored';

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
  /**
   * By VAT rate, of what was charged. Each sale's net and VAT are shared
   * out over its rates in whole cents, so the rows add up to `sales`
   * exactly (QA v0.2.104, #9).
   */
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
  /** Bills printed before payment in the period (`billSlip.ts`). */
  billsPrinted: number;
  /**
   * The drawer, in the till's currency (`currency`). Opening float and cash
   * in/out are declared to easyPos in lekë (`declared`); on a till that
   * does not sell in lekë they are converted with Kursi EUR, and when there
   * is no rate they are shown in lekë only and `expected` is null: lekë
   * were added to euros before (QA v0.2.104, #2).
   */
  cash: {
    currency: string;
    opening: number | null;
    sales: number;
    /**
     * Cash given back in the period for sales paid in cash, whatever
     * period those sales were in. It used to be left in "expected", so
     * the drawer read over by every refund.
     */
    refunds: number;
    deposits: number | null;
    withdrawals: number | null;
    expected: number | null;
    declared: {
      currency: 'ALL';
      opening: number | null;
      /** The fiscal day (YYYY-MM-DD, Tirana) whose float `opening` is. */
      openingDay?: string | null;
      deposits: number;
      withdrawals: number;
      /** ALL per 1 unit of `currency`; 1 on a lek till; null when missing. */
      rate: number | null;
    };
  };
};

/** Cents, so sums never drift. */
const cents = (n: unknown) => Math.round(Number(n || 0) * 100);
const fromCents = (c: number) => c / 100;

/**
 * Split `total` cents over `weights` in proportion, in whole cents, the
 * remainder going to the largest fractions (ties: first key). Sums to
 * `total` exactly.
 */
export function allocateCents(
  total: number,
  weights: Array<[number, number]>,
): Map<number, number> {
  const out = new Map<number, number>();
  const positive = weights.filter(([, w]) => Number.isFinite(w) && w > 0);
  if (!positive.length) return out;
  const sumW = positive.reduce((a, [, w]) => a + w, 0);
  let given = 0;
  const fracs: Array<{ key: number; frac: number; i: number }> = [];
  positive.forEach(([key, w], i) => {
    const exact = (total * w) / sumW;
    const whole = Math.floor(exact);
    out.set(key, (out.get(key) ?? 0) + whole);
    given += whole;
    fracs.push({ key, frac: exact - whole, i });
  });
  fracs.sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < total - given; k++) {
    const f = fracs[k % fracs.length];
    out.set(f.key, (out.get(f.key) ?? 0) + 1);
  }
  return out;
}

/**
 * Each declaration once (QA v0.2.104, #1). A retry with the same key is
 * logged again ("already declared") and was summed again: 2.01 of real cash
 * in showed as 6.01. Keyed on the easyPos document id (one per request
 * key), counted at its first accepted entry, so a repeat in a later period
 * is not counted there either.
 */
export function uniqueDeclarations<
  T extends {
    at: string;
    ok: boolean;
    docId?: string;
    requestKey?: string | null;
    kind: string;
  },
>(entries: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  entries.forEach((d, i) => {
    if (!d.ok) return;
    const id = String(d.docId || d.requestKey || '').trim();
    const key = id ? `${d.kind}:${id}` : `entry:${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  });
  return out;
}

/** A correction that handed cash back: the sale it reverses was paid in cash. */
export function correctionIsCashRefund(c: {
  amountDelta: unknown;
  order?: { payments?: Array<{ method?: string }> } | null;
}): boolean {
  if (!(cents(c.amountDelta) < 0)) return false;
  const method = String(c.order?.payments?.[0]?.method || '').toUpperCase();
  return method === 'CASH';
}

type Stored = { number: number; to: string };

async function readJson<T>(
  key: string,
  opts?: { strict?: boolean },
): Promise<T | null> {
  const read = prisma.syncState.findUnique({ where: { key } });
  // Strict where a wrong "nothing there" would do harm: the last Z read as
  // missing numbered the next one 1 and wrote it over report 1.
  const row = opts?.strict
    ? await read
    : await read.catch(logIgnored('zReport:readJson', null));
  return ((row as any)?.valueJson as T) ?? null;
}

/** All or none. */
async function writeJsonAll(
  entries: Array<[key: string, valueJson: unknown]>,
): Promise<void> {
  await prisma.$transaction(
    entries.map(([key, valueJson]) =>
      prisma.syncState.upsert({
        where: { key },
        create: { key, valueJson: valueJson as any },
        update: { valueJson: valueJson as any },
      }),
    ),
  );
}

/**
 * The opening float that starts this period's drawer: the one declared for
 * the fiscal day the period starts on, or else the first day in the period
 * that has one. It used to be today's, whatever the period: a Z issued
 * after midnight showed no float and no expected cash, and a Z covering
 * several days took the last day's (audit 2026-11, H2). Counted once: over
 * several days the cash carries over in the drawer.
 */
async function openingFloatForPeriod(
  settings: any,
  from: Date,
  to: Date,
): Promise<{ amount: number; dayKey: string } | null> {
  for (const dayKey of fiscalDayKeysBetween(from.getTime(), to.getTime())) {
    const record = await readDailyBalanceRecord(settings, dayKey, {
      strict: true,
    });
    if (
      record?.state === 'COMPLETE' &&
      Number.isFinite(Number(record.amount))
    ) {
      return { amount: Number(record.amount), dayKey };
    }
  }
  return null;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const Z_COMPUTE_FAILED = 'Z_COMPUTE_FAILED';

/**
 * The figures for `[from, to]`. Pure read: no number, nothing stored.
 *
 * Every figure is read to the end or the whole report fails: a part that
 * could not be read used to come out as zero, and the report was then
 * numbered and kept with the wrong figures for good.
 */
export async function computeZReport(input: {
  from: Date;
  to: Date;
  settings?: unknown;
}): Promise<Omit<ZReport, 'number' | 'issuedAt' | 'issuedByUserId'>> {
  try {
    return await computeZReportFigures(input);
  } catch (e: any) {
    console.error('[zReport] could not compute the report', e);
    throw Object.assign(
      new Error(
        `The Z report could not be computed, so none was issued (${String(
          e?.message || e,
        )}). Try again.`,
      ),
      { code: Z_COMPUTE_FAILED, cause: e },
    );
  }
}

async function computeZReportFigures(input: {
  from: Date;
  to: Date;
  settings?: unknown;
}): Promise<Omit<ZReport, 'number' | 'issuedAt' | 'issuedByUserId'>> {
  const settings: any = input.settings ?? (await coreServices.readSettings());
  const vatEnabled = isVatEnabledFromSettings(settings);
  const fiscalEnabled = settings?.fiscal?.enabled === true;
  const defaultVatRate = Number(settings?.defaultVatRate || 0);
  const { from, to } = input;

  const sales = await fetchPaidSales({ from, to });
  // One strategy everywhere: each sale in whole cents (its gross and VAT as
  // charged), net = gross - VAT, everything else sums those cents.
  const totals = { count: sales.length, vat: 0, gross: 0 };
  const methods = new Map<string, { count: number; amount: number }>();
  for (const s of sales) {
    totals.vat += cents(vatEnabled ? s.vatAmount : 0);
    totals.gross += cents(s.total);
    const m = methods.get(s.paymentMethod) ?? { count: 0, amount: 0 };
    m.count += 1;
    m.amount += cents(s.total);
    methods.set(s.paymentMethod, m);
  }

  const orderIds = sales
    .map((s) => Number(s.orderId))
    .filter((n) => Number.isInteger(n) && n > 0);
  const filedOrders = new Set<number>();
  /** Item gross per VAT rate, per order. */
  const lineRates = new Map<number, Map<number, number>>();
  for (const ids of chunks(orderIds, 500)) {
    const payments = (await prisma.payment.findMany({
      where: { orderId: { in: ids } } as any,
      select: { orderId: true, fiscalNivf: true } as any,
    })) as Array<{ orderId: number; fiscalNivf?: string }>;
    for (const p of payments) {
      if (String(p.fiscalNivf || '').trim()) filedOrders.add(Number(p.orderId));
    }
    if (vatEnabled) {
      const lines = (await prisma.orderItem.findMany({
        where: { orderId: { in: ids }, voidedAt: null } as any,
        select: {
          orderId: true,
          qty: true,
          unitPrice: true,
          vatRate: true,
        } as any,
      })) as Array<{
        orderId?: unknown;
        qty: unknown;
        unitPrice: unknown;
        vatRate: unknown;
      }>;
      for (const l of lines) {
        const gross = Number(l.qty) * Number(l.unitPrice);
        if (!Number.isFinite(gross)) continue;
        const rate = effectiveVatRate(l.vatRate, defaultVatRate);
        const id = Number(l.orderId);
        const m = lineRates.get(id) ?? new Map<number, number>();
        m.set(rate, (m.get(rate) ?? 0) + gross);
        lineRates.set(id, m);
      }
    }
  }
  let filedAmount = 0;
  let notFiledAmount = 0;
  let filedCount = 0;
  for (const s of sales) {
    if (s.orderId && filedOrders.has(Number(s.orderId))) {
      filedCount += 1;
      filedAmount += cents(s.total);
    } else {
      notFiledAmount += cents(s.total);
    }
  }

  // VAT by rate: each sale's gross shared over its items' rates, and its
  // VAT over their VAT content, in cents. A sale with no item rows counts
  // at the default rate.
  const byRate = new Map<number, { gross: number; vat: number }>();
  if (vatEnabled) {
    for (const s of sales) {
      const own = lineRates.get(Number(s.orderId));
      const weights: Array<[number, number]> = own?.size
        ? [...own.entries()]
        : [[effectiveVatRate(undefined, defaultVatRate), 1]];
      const gross = allocateCents(cents(s.total), weights);
      const vat = allocateCents(
        cents(s.vatAmount),
        weights.map(([r, w]) => [r, (w * r) / (1 + r)]),
      );
      // All of a sale's VAT on 0% lines (no VAT content to weigh by).
      if (!vat.size && cents(s.vatAmount)) {
        vat.set(weights[0][0], cents(s.vatAmount));
      }
      for (const [r] of weights) {
        const row = byRate.get(r) ?? { gross: 0, vat: 0 };
        row.gross += gross.get(r) ?? 0;
        row.vat += vat.get(r) ?? 0;
        byRate.set(r, row);
      }
    }
  }

  const corrections = (await prisma.saleCorrection.findMany({
    where: { createdAt: { gte: from, lte: to } } as any,
    select: {
      kind: true,
      amountDelta: true,
      order: { select: { payments: { select: { method: true } } } },
    } as any,
  })) as Array<{
    kind: string;
    amountDelta: unknown;
    order?: { payments?: Array<{ method?: string }> } | null;
  }>;
  const cashRefundCents = corrections.reduce(
    (a, c) => a + (correctionIsCashRefund(c) ? -cents(c.amountDelta) : 0),
    0,
  );

  const [voidedTickets, billsPrinted, queued, review, declarations, opening] =
    await Promise.all([
      countVoidedTickets(from, to, { strict: true }),
      countBillEventsBetween(['BILL_PRINTED'], from, to),
      fiscalEnabled
        ? listFiscalClaimsDeferred().then((r) => r.length)
        : Promise.resolve(0),
      fiscalEnabled
        ? listFiscalClaimsNeedingReview().then((r) => r.length)
        : Promise.resolve(0),
      listCashDeclarations({ strict: true }),
      fiscalEnabled
        ? openingFloatForPeriod(settings, from, to)
        : Promise.resolve(null),
    ]);
  const inPeriod = uniqueDeclarations(declarations).filter((d) => {
    const at = Date.parse(d.at);
    return at >= from.getTime() && at <= to.getTime();
  });
  const sumCents = (kind: string) =>
    inPeriod
      .filter((d) => d.kind === kind)
      .reduce((a, d) => a + cents(d.amount), 0);
  const currency = String(settings?.currency || 'EUR').toUpperCase();
  // Declared amounts are lekë (`balance.ts`).
  const rate = currency === 'ALL' ? 1 : eurExchangeRateFromSettings(settings);
  const convertible =
    currency === 'ALL' || (currency === 'EUR' && rate != null);
  const toTill = (allCents: number) =>
    convertible ? Math.round(allCents / Number(rate)) : null;
  const openingAll = opening ? cents(opening.amount) : null;
  const depositsAll = sumCents('deposit');
  const withdrawalsAll = sumCents('withdraw');
  const cashSalesCents = methods.get('CASH')?.amount ?? 0;
  const openingTill = openingAll == null ? null : toTill(openingAll);
  const depositsTill = toTill(depositsAll);
  const withdrawalsTill = toTill(withdrawalsAll);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    currency: String(settings?.currency || 'EUR'),
    vatEnabled,
    fiscalEnabled,
    sales: {
      count: totals.count,
      net: fromCents(totals.gross - totals.vat),
      vat: fromCents(totals.vat),
      gross: fromCents(totals.gross),
    },
    byMethod: [...methods.entries()]
      .map(([method, m]) => ({
        method,
        count: m.count,
        amount: fromCents(m.amount),
      }))
      .sort((a, b) => b.amount - a.amount),
    byVatRate: [...byRate.entries()]
      .map(([r, row]) => ({
        rate: r,
        net: fromCents(row.gross - row.vat),
        vat: fromCents(row.vat),
        gross: fromCents(row.gross),
      }))
      .sort((a, b) => b.rate - a.rate),
    fiscal: {
      filedCount,
      filedAmount: fromCents(filedAmount),
      notFiledCount: fiscalEnabled ? totals.count - filedCount : 0,
      notFiledAmount: fiscalEnabled ? fromCents(notFiledAmount) : 0,
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
    billsPrinted,
    cash: {
      currency,
      opening: openingTill == null ? null : fromCents(openingTill),
      sales: fromCents(cashSalesCents),
      refunds: fromCents(cashRefundCents),
      deposits: depositsTill == null ? null : fromCents(depositsTill),
      withdrawals: withdrawalsTill == null ? null : fromCents(withdrawalsTill),
      expected:
        openingTill == null || depositsTill == null || withdrawalsTill == null
          ? null
          : fromCents(
              openingTill +
                cashSalesCents -
                cashRefundCents +
                depositsTill -
                withdrawalsTill,
            ),
      declared: {
        currency: 'ALL',
        opening: openingAll == null ? null : fromCents(openingAll),
        openingDay: opening?.dayKey ?? null,
        deposits: fromCents(depositsAll),
        withdrawals: fromCents(withdrawalsAll),
        rate: convertible ? Number(rate) : null,
      },
    },
  };
}

const zLock = new KeyedAsyncMutex();

/**
 * Close the period since the last Z: compute, number, store and print it.
 * One at a time, so two presses never make two reports for one period.
 */
/** Nothing happened since the last Z (QA v0.2.104, #8). */
export function zReportIsEmpty(
  z: Pick<ZReport, 'sales' | 'corrections' | 'voidedTickets' | 'cash'>,
): boolean {
  return (
    z.sales.count === 0 &&
    z.corrections.count === 0 &&
    !z.voidedTickets &&
    !z.cash.declared.deposits &&
    !z.cash.declared.withdrawals
  );
}

export type IssueZResult =
  | { report: ZReport; printed: boolean }
  /** Not issued: no activity since `from`. Ask, then pass `confirmEmpty`. */
  | { empty: true; from: string; lastNumber: number };

export async function issueZReport(input: {
  actorUserId?: number | null;
  now?: Date;
  print?: (z: ZReport, copy: boolean) => Promise<boolean>;
  /** Issue it even with nothing in the period. */
  confirmEmpty?: boolean;
}): Promise<IssueZResult> {
  return zLock.runExclusive('z', async () => {
    const last = await readJson<Stored>(LAST_KEY, { strict: true });
    const lastTo = last?.to ? new Date(last.to) : null;
    const hasLast = Boolean(lastTo && Number.isFinite(lastTo.getTime()));
    // Always from where the last Z ended, even when the clock has not moved
    // on (two presses in one millisecond): the period is then empty, never
    // the day again.
    const from = hasLast
      ? new Date(lastTo!.getTime() + 1)
      : startOfFiscalDay((input.now ?? new Date()).getTime());
    const asked = input.now ?? new Date();
    const now = asked.getTime() >= from.getTime() ? asked : from;
    const figures = await computeZReport({ from, to: now });
    // An empty Z right after another closed nothing and used a number.
    if (!input.confirmEmpty && zReportIsEmpty(figures)) {
      return {
        empty: true as const,
        from: figures.from,
        lastNumber: last?.number ?? 0,
      };
    }
    const report: ZReport = {
      ...figures,
      number: (last?.number ?? 0) + 1,
      issuedAt: now.toISOString(),
      issuedByUserId: Number(input.actorUserId || 0) || null,
    };
    // The report is stored before it is printed: a printer problem never
    // loses a Z or lets the same period be closed twice. Report and pointer
    // go in one transaction: a crash between the two used to leave a
    // report whose number the next Z took again.
    await writeJsonAll([
      [recordKey(report.number), report],
      [LAST_KEY, { number: report.number, to: report.to }],
    ]);
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
  return {
    ok: true,
    printed: await print(z, true).catch(logIgnored('zReport:594', false)),
  };
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
