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
    readSettings: async () => ({
      currency: 'ALL',
      defaultVatRate: 0.2,
      restaurantName: 'Bast',
      fiscal: { enabled: true, vat: {} },
    }),
  },
}));
vi.mock('./paidAnalytics', () => ({
  fetchPaidSales: async (args: { from: Date; to: Date }) => {
    h.fetchArgs.push(args);
    return h.sales;
  },
  countVoidedTickets: async () => 2,
}));
vi.mock('./fiscal/cashDrawer', () => ({
  listCashDeclarations: async () => h.declarations,
}));
vi.mock('./fiscal/balance', () => ({
  readDailyBalanceRecord: async () => ({ state: 'COMPLETE', amount: 10_000 }),
}));
vi.mock('./fiscal/claims', () => ({
  listFiscalClaimsDeferred: async () => [{}, {}],
  listFiscalClaimsNeedingReview: async () => [{}],
}));

import {
  issueZReport,
  listZReports,
  reprintZReport,
  type ZReport,
} from './zReport';
import { buildEscposTicket, buildHtmlReceipt, zReportRows } from '../print';

const sale = (orderId: number, total: number, method: string) => ({
  orderId,
  closedAt: new Date(),
  subtotal: total / 1.2,
  vatAmount: total - total / 1.2,
  total,
  paymentMethod: method,
});

beforeEach(() => {
  h.store.clear();
  h.fetchArgs = [];
  h.sales = [sale(1, 600, 'CASH'), sale(2, 1200, 'CARD'), sale(3, 300, 'CASH')];
  h.payments = [
    { orderId: 1, fiscalNivf: 'N1' },
    { orderId: 2, fiscalNivf: 'N2' },
    { orderId: 3, fiscalNivf: null },
  ];
  h.items = [
    { qty: 1, unitPrice: 600, vatRate: 0.2 },
    { qty: 2, unitPrice: 600, vatRate: 0.2 },
    { qty: 1, unitPrice: 300, vatRate: 0.06 },
  ];
  h.corrections = [{ kind: 'CANCEL', amountDelta: -500 }];
  h.declarations = [
    { at: new Date().toISOString(), kind: 'deposit', amount: 2000, ok: true },
    { at: new Date().toISOString(), kind: 'withdraw', amount: 500, ok: true },
    { at: new Date().toISOString(), kind: 'deposit', amount: 9999, ok: false },
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
    expect(report.byVatRate.map((r) => [r.rate, r.gross])).toEqual([
      [0.2, 1800],
      [0.06, 300],
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
      opening: 10_000,
      sales: 900,
      deposits: 2000,
      withdrawals: 500,
      expected: 12_400,
    });
  });

  it('numbers in sequence, and each Z starts where the last one ended', async () => {
    const t1 = new Date('2026-11-02T22:00:00');
    const t2 = new Date('2026-11-03T22:30:00');
    const a = await issueZReport({ now: t1, print: noPrint });
    const b = await issueZReport({ now: t2, print: noPrint });
    expect([a.report.number, b.report.number]).toEqual([1, 2]);
    // The first one starts at the start of its day.
    expect(new Date(a.report.from).getHours()).toBe(0);
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
