/** QA v0.2.103, fiscal compliance: the end-of-day Z report. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, any>(),
  sales: [] as any[],
  payments: [] as any[],
  items: [] as any[],
  corrections: [] as any[],
  declarations: [] as any[],
  fetchArgs: [] as Array<{ from: Date; to: Date }>,
  settings: {} as any,
  voided: 2,
  /** Declared opening floats by fiscal day; `*` answers for any day. */
  floats: new Map<string, number>(),
}));

vi.mock('@db/client', () => ({
  prisma: {
    syncState: {
      findUnique: async ({ where }: any) =>
        h.store.has(where.key) ? { valueJson: h.store.get(where.key) } : null,
      upsert: async ({ where, update }: any) => {
        h.store.set(where.key, structuredClone(update.valueJson));
        return {};
      },
    },
    payment: { findMany: async () => h.payments },
    orderItem: { findMany: async () => h.items },
    saleCorrection: { findMany: async () => h.corrections },
  },
}));
vi.mock('./core', () => ({
  coreServices: {
    readSettings: async () => h.settings,
  },
}));
vi.mock('./paidAnalytics', () => ({
  fetchPaidSales: async (args: { from: Date; to: Date }) => {
    h.fetchArgs.push(args);
    return h.sales;
  },
  countVoidedTickets: async () => h.voided,
}));
vi.mock('./fiscal/cashDrawer', () => ({
  listCashDeclarations: async () => h.declarations,
}));
vi.mock('./fiscal/balance', () => ({
  readDailyBalanceRecord: async (_settings: unknown, dayKey: string) => {
    const amount = h.floats.get(dayKey) ?? h.floats.get('*');
    return amount == null ? null : { state: 'COMPLETE', amount };
  },
}));
vi.mock('./fiscal/claims', () => ({
  listFiscalClaimsDeferred: async () => [{}, {}],
  listFiscalClaimsNeedingReview: async () => [{}],
}));

import {
  allocateCents,
  issueZReport as issueAny,
  listZReports,
  reprintZReport,
  type ZReport,
} from './zReport';

/** Issued (not refused as empty). */
async function issueZReport(input: Parameters<typeof issueAny>[0]) {
  const r = await issueAny(input);
  if ('empty' in r) throw new Error('refused as empty');
  return r;
}
import { buildEscposTicket, buildHtmlReceipt, zReportRows } from '../print';
import { fiscalDayKey, startOfFiscalDay } from './fiscal/clock';

const sale = (orderId: number, total: number, method: string) => ({
  orderId,
  closedAt: new Date(),
  subtotal: total / 1.2,
  vatAmount: total - total / 1.2,
  total,
  paymentMethod: method,
});

beforeEach(() => {
  h.settings = {
    currency: 'ALL',
    defaultVatRate: 0.2,
    restaurantName: 'Bast',
    fiscal: { enabled: true, vat: {} },
  };
  h.voided = 2;
  h.floats = new Map([['*', 10_000]]);
  h.store.clear();
  h.fetchArgs = [];
  h.sales = [sale(1, 600, 'CASH'), sale(2, 1200, 'CARD'), sale(3, 300, 'CASH')];
  h.payments = [
    { orderId: 1, fiscalNivf: 'N1' },
    { orderId: 2, fiscalNivf: 'N2' },
    { orderId: 3, fiscalNivf: null },
  ];
  h.items = [
    { orderId: 1, qty: 1, unitPrice: 600, vatRate: 0.2 },
    { orderId: 2, qty: 2, unitPrice: 600, vatRate: 0.2 },
    { orderId: 3, qty: 1, unitPrice: 300, vatRate: 0.06 },
  ];
  h.corrections = [{ kind: 'CANCEL', amountDelta: -500 }];
  const at = new Date().toISOString();
  h.declarations = [
    { at, kind: 'deposit', amount: 2000, ok: true, docId: 'cash-a' },
    { at, kind: 'withdraw', amount: 500, ok: true, docId: 'cash-b' },
    { at, kind: 'deposit', amount: 9999, ok: false, docId: 'cash-c' },
  ];
});

const noPrint = async () => true;

describe('Z report', () => {
  it('states the day: sales, payments, VAT, fiskalizimi, corrections and the drawer', async () => {
    const { report } = await issueZReport({ actorUserId: 1, print: noPrint });
    expect(report.number).toBe(1);
    expect(report.sales).toEqual({
      count: 3,
      net: 1750,
      vat: 350,
      gross: 2100,
    });
    expect(report.byMethod).toEqual([
      { method: 'CARD', count: 1, amount: 1200 },
      { method: 'CASH', count: 2, amount: 900 },
    ]);
    expect(
      report.byVatRate.map((r) => [r.rate, r.net, r.vat, r.gross]),
    ).toEqual([
      [0.2, 1500, 300, 1800],
      [0.06, 250, 50, 300],
    ]);
    expect(report.fiscal).toEqual({
      filedCount: 2,
      filedAmount: 1800,
      notFiledCount: 1,
      notFiledAmount: 300,
      queued: 2,
      waitingForReview: 1,
    });
    expect(report.corrections).toEqual({
      count: 1,
      cancellations: 1,
      amount: -500,
    });
    expect(report.voidedTickets).toBe(2);
    // Refused declarations do not count: 10000 + 900 + 2000 - 500.
    expect(report.cash).toEqual({
      currency: 'ALL',
      opening: 10_000,
      sales: 900,
      deposits: 2000,
      withdrawals: 500,
      expected: 12_400,
      declared: {
        currency: 'ALL',
        opening: 10_000,
        openingDay: fiscalDayKey(Date.parse(report.from)),
        deposits: 2000,
        withdrawals: 500,
        rate: 1,
      },
    });
  });

  it('reconciles exactly with the sales and the cash declared', async () => {
    // Odd amounts, mixed rates, a discount (gross below the items): the
    // rounding QA saw drift by 7 cents (#9).
    const odd = [
      { id: 1, total: 3.33, vat: 0.56, method: 'CASH', items: [[3.333, 0.2]] },
      {
        id: 2,
        total: 10.01,
        vat: 1.07,
        method: 'CARD',
        items: [
          [5.55, 0.2],
          [4.46, 0.06],
        ],
      },
      {
        id: 3,
        total: 7.77,
        vat: 0.88,
        method: 'CASH',
        items: [
          [4, 0.2],
          [4, 0.06],
        ],
      },
      { id: 4, total: 0.99, vat: 0.17, method: 'CASH', items: [[0.99, 0.2]] },
    ];
    h.sales = odd.map((o) => ({
      orderId: o.id,
      closedAt: new Date(),
      subtotal: o.total - o.vat,
      vatAmount: o.vat,
      total: o.total,
      paymentMethod: o.method,
    }));
    h.items = odd.flatMap((o) =>
      o.items.map(([unitPrice, vatRate]) => ({
        orderId: o.id,
        qty: 1,
        unitPrice,
        vatRate,
      })),
    );
    const at = new Date().toISOString();
    h.declarations = [
      { at, kind: 'deposit', amount: 2.01, ok: true, docId: 'cash-x' },
      { at, kind: 'withdraw', amount: 0.5, ok: true, docId: 'cash-y' },
    ];
    const { report: z } = await issueZReport({ print: noPrint });
    const c = (n: number) => Math.round(n * 100);
    const sum = (rows: any[], k: string) =>
      rows.reduce((a, r) => a + c(r[k]), 0);
    // Sales are what was charged, to the cent.
    expect(c(z.sales.gross)).toBe(sum(h.sales, 'total'));
    expect(c(z.sales.vat)).toBe(sum(h.sales, 'vatAmount'));
    expect(c(z.sales.net)).toBe(c(z.sales.gross) - c(z.sales.vat));
    // Every breakdown adds up to them, with no cent left over.
    for (const k of ['net', 'vat', 'gross']) {
      expect(sum(z.byVatRate, k)).toBe(c((z.sales as any)[k]));
    }
    expect(sum(z.byMethod, 'amount')).toBe(c(z.sales.gross));
    expect(c(z.fiscal.filedAmount) + c(z.fiscal.notFiledAmount)).toBe(
      c(z.sales.gross),
    );
    // The drawer: float + cash sales + in - out.
    expect(z.cash.sales).toBe(12.09);
    expect(c(z.cash.expected!)).toBe(c(10_000) + c(12.09) + c(2.01) - c(0.5));
  });

  it('counts a repeated declaration once (QA #1)', async () => {
    const t = new Date().toISOString();
    // One cash-in of 2.01 retried twice: the till logs each answer.
    h.declarations = [
      {
        at: t,
        kind: 'deposit',
        amount: 2.01,
        ok: true,
        docId: 'cash-k1',
        outcome: 'complete',
      },
      {
        at: t,
        kind: 'deposit',
        amount: 2.01,
        ok: true,
        docId: 'cash-k1',
        outcome: 'already-declared',
      },
      {
        at: t,
        kind: 'deposit',
        amount: 2.01,
        ok: true,
        docId: 'cash-k1',
        outcome: 'already-declared',
      },
    ];
    const { report } = await issueZReport({ print: noPrint });
    expect(report.cash.deposits).toBe(2.01);
  });

  it('does not count, in a later Z, a repeat of a declaration already counted', async () => {
    const first = new Date('2026-11-02T10:00:00');
    h.declarations = [
      {
        at: first.toISOString(),
        kind: 'deposit',
        amount: 5,
        ok: true,
        docId: 'cash-k2',
      },
    ];
    const a = await issueZReport({
      now: new Date('2026-11-02T12:00:00'),
      print: noPrint,
    });
    expect(a.report.cash.deposits).toBe(5);
    h.declarations.push({
      at: new Date('2026-11-02T13:00:00').toISOString(),
      kind: 'deposit',
      amount: 5,
      ok: true,
      docId: 'cash-k2',
    });
    const b = await issueZReport({
      now: new Date('2026-11-02T14:00:00'),
      print: noPrint,
    });
    expect(b.report.cash.deposits).toBe(0);
  });

  it('never adds lekë to euros: converts with Kursi EUR, labelled (QA #2)', async () => {
    h.settings = {
      ...h.settings,
      currency: 'EUR',
      fiscal: { ...h.settings.fiscal, eurExchangeRate: 100 },
    };
    // 10000 ALL float, 2000 ALL in, 500 ALL out; 900 EUR cash sales.
    const { report } = await issueZReport({ print: noPrint });
    expect(report.cash).toMatchObject({
      currency: 'EUR',
      opening: 100,
      sales: 900,
      deposits: 20,
      withdrawals: 5,
      expected: 1015,
      declared: {
        currency: 'ALL',
        opening: 10_000,
        deposits: 2000,
        withdrawals: 500,
        rate: 100,
      },
    });
  });

  it('without a rate shows lekë apart and no expected cash (QA #2)', async () => {
    h.settings = { ...h.settings, currency: 'EUR' };
    const { report } = await issueZReport({ print: noPrint });
    expect(report.cash).toMatchObject({
      currency: 'EUR',
      opening: null,
      sales: 900,
      deposits: null,
      withdrawals: null,
      expected: null,
      declared: {
        currency: 'ALL',
        opening: 10_000,
        deposits: 2000,
        rate: null,
      },
    });
    const rows = zReportRows(report, {
      copy: false,
      lang: 'en',
      restaurant: 'B',
    });
    const text = rows
      .map((r: any) => `${r.label ?? ''} ${r.value ?? r.text ?? ''}`)
      .join('\n');
    expect(text).toMatch(/Cash in.*2[ ,.]?000[.,]00 ALL/);
    expect(text).not.toMatch(/Cash expected.*\d/);
  });

  it('asks before issuing an empty Z right after another (QA #8)', async () => {
    const first = await issueZReport({ print: noPrint });
    h.sales = [];
    h.corrections = [];
    h.declarations = [];
    h.voided = 0;
    const again = await issueAny({ print: noPrint });
    expect(again).toMatchObject({
      empty: true,
      lastNumber: first.report.number,
    });
    expect((await listZReports()).length).toBe(1);
    const forced = await issueZReport({ print: noPrint, confirmEmpty: true });
    expect(forced.report.number).toBe(2);
  });
});

describe('allocateCents', () => {
  it('shares out every cent, in proportion', () => {
    const m = allocateCents(100, [
      [0.2, 1],
      [0.06, 1],
      [0.1, 1],
    ]);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(100);
    expect([...m.values()].sort()).toEqual([33, 33, 34]);
    expect(allocateCents(5, [])).toEqual(new Map());
  });
});

describe('Z report numbering and printing', () => {
  it('numbers in sequence, and each Z starts where the last one ended', async () => {
    const t1 = new Date('2026-11-02T22:00:00');
    const t2 = new Date('2026-11-03T22:30:00');
    const a = await issueZReport({ now: t1, print: noPrint });
    const b = await issueZReport({ now: t2, print: noPrint });
    expect([a.report.number, b.report.number]).toEqual([1, 2]);
    // The first one starts at midnight, Tirana time, of its fiscal day.
    expect(a.report.from).toBe(startOfFiscalDay(t1.getTime()).toISOString());
    // No gap and no overlap between them.
    expect(Date.parse(b.report.from)).toBe(Date.parse(a.report.to) + 1);
    expect(h.fetchArgs[1].from.getTime()).toBe(Date.parse(a.report.to) + 1);
    expect((await listZReports()).map((z) => z.number)).toEqual([2, 1]);
  });

  it('two presses at once make two consecutive reports, never the same period twice', async () => {
    const [x, y] = await Promise.all([
      issueZReport({ print: noPrint }),
      issueZReport({ print: noPrint }),
    ]);
    expect([x.report.number, y.report.number].sort()).toEqual([1, 2]);
    const [first, second] = [x.report, y.report].sort(
      (p, q) => p.number - q.number,
    );
    expect(Date.parse(second.from)).toBeGreaterThan(Date.parse(first.to));
  });

  it('is stored before printing, and a reprint is the stored copy, marked as such', async () => {
    const printed: Array<{ z: ZReport; copy: boolean }> = [];
    const print = async (z: ZReport, copy: boolean) => {
      printed.push({ z, copy });
      return false; // printer down
    };
    const { report, printed: ok } = await issueZReport({ print });
    expect(ok).toBe(false);
    // Saved anyway.
    expect((await listZReports())[0].number).toBe(report.number);
    // The figures change afterwards; the reprint does not.
    h.sales = [];
    const r = await reprintZReport(report.number, print);
    expect(r.ok).toBe(true);
    expect(printed[1]).toMatchObject({ copy: true });
    expect(printed[1].z.sales.gross).toBe(2100);
    expect(await reprintZReport(99, print)).toMatchObject({ ok: false });
  });

  it('prints the same lines on thermal and system printers, copies marked KOPJE / COPY', async () => {
    const { report } = await issueZReport({ print: noPrint });
    const settings = {
      restaurantName: 'Bast',
      currency: 'ALL',
      preferences: { language: 'sq' },
    } as any;
    const rows = zReportRows(report, {
      copy: false,
      lang: 'sq',
      restaurant: 'Bast',
    });
    expect(
      rows.some((r) => r.kind === 'title' && /RAPORTI Z/.test(r.text)),
    ).toBe(true);
    const payload = (copy: boolean) =>
      ({
        area: 'Z',
        tableLabel: '1',
        items: [],
        meta: {
          kind: 'Z_REPORT',
          zReport: report,
          ...(copy ? { reprint: true } : {}),
        },
      }) as any;
    const thermal = buildEscposTicket(payload(false), settings).toString(
      'latin1',
    );
    expect(thermal).toContain('RAPORTI Z');
    expect(thermal).not.toContain('KOPJE / COPY');
    expect(
      buildEscposTicket(payload(true), settings).toString('latin1'),
    ).toContain('KOPJE / COPY');
    const html = buildHtmlReceipt(payload(true), settings);
    expect(html).toContain('RAPORTI Z');
    expect(html).toContain('KOPJE / COPY');
  });
});

describe('opening float of the period (audit 2026-11, H2)', () => {
  it('a Z issued after midnight uses the float of the day it closes', async () => {
    // 4 Nov declared 8,000; 5 Nov (today, after midnight) not yet.
    h.floats = new Map([['2026-11-04', 8_000]]);
    h.store.set('z:last', {
      number: 3,
      to: new Date('2026-11-04T06:00:00Z').toISOString(),
    });
    const { report } = await issueZReport({
      now: new Date('2026-11-04T23:40:00Z'), // 00:40 on 5 Nov in Tirana
      print: noPrint,
    });
    expect(fiscalDayKey(Date.parse(report.issuedAt))).toBe('2026-11-05');
    expect(report.cash.opening).toBe(8_000);
    expect(report.cash.declared.openingDay).toBe('2026-11-04');
    // Float + cash sales (no cash in/out in this past period).
    expect(report.cash.expected).toBe(8_000 + 900);
    const rows = zReportRows(report, {
      copy: false,
      lang: 'en',
      restaurant: 'B',
    });
    expect(
      rows.some((r: any) => /Opening float \(2026-11-04\)/.test(r.label ?? '')),
    ).toBe(true);
  });

  it('over several days, the float of the first day is counted once', async () => {
    h.floats = new Map([
      ['2026-11-02', 5_000],
      ['2026-11-03', 7_000],
    ]);
    h.store.set('z:last', {
      number: 1,
      to: new Date('2026-11-02T05:00:00Z').toISOString(),
    });
    const { report } = await issueZReport({
      now: new Date('2026-11-03T21:00:00Z'),
      print: noPrint,
    });
    expect(report.cash.opening).toBe(5_000);
    expect(report.cash.declared.openingDay).toBe('2026-11-02');
  });

  it('no float declared in the period: no opening and no expected cash', async () => {
    h.floats = new Map();
    const { report } = await issueZReport({ print: noPrint });
    expect(report.cash.opening).toBeNull();
    expect(report.cash.expected).toBeNull();
  });
});

describe('fiscal day boundaries', () => {
  it('starts the fiscal day at midnight in Tirana, summer and winter', () => {
    // Winter (UTC+1): 5 Nov starts 4 Nov 23:00 UTC.
    expect(
      startOfFiscalDay(Date.parse('2026-11-05T10:00:00Z')).toISOString(),
    ).toBe('2026-11-04T23:00:00.000Z');
    // Summer (UTC+2): 1 Jul starts 30 Jun 22:00 UTC.
    expect(
      startOfFiscalDay(Date.parse('2026-07-01T10:00:00Z')).toISOString(),
    ).toBe('2026-06-30T22:00:00.000Z');
  });
});
