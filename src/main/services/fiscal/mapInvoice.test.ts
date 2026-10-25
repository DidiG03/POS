/**
 * easyPos rejects an invoice whose article lines do not add up to the payment
 * amount, and the reconciliation that prevents that compares two numbers
 * produced in different places: the payment total the POS charged, and the sum
 * of the article lines. Both have to be rounded the same way or a ticket that
 * balances perfectly on the receipt arrives at the tax service a cent out.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import { roundMoney } from '@shared/pricing';
import {
  bandChangeBetween,
  buildCorrectionDifferenceLines,
  invoiceBandTotals,
  buildEasyPosCloudInvoiceDraft,
  buildRestatedInvoiceLines,
  fiscalItemName,
} from './mapInvoice';

const settings = {
  currency: 'ALL',
  defaultVatRate: 0.2,
  fiscal: {
    baseUrl: 'https://api.dev.easypos.al/fiscalisation-service/v1',
    defaultSoldIn: 'XPP',
    defaultOperatorId: 'gh537ez280',
    integrationApp: 'generic',
    authToken: 'jwt',
  },
} as unknown as SettingsDTO;

const payload = (
  items: Array<{ name: string; qty: number; unitPrice: number }>,
  meta: Record<string, unknown>,
) =>
  ({
    area: 'Inside',
    tableLabel: 'T1',
    items,
    meta: { method: 'CASH', ...meta },
  }) as any;

describe('buildEasyPosCloudInvoiceDraft rounding', () => {
  it('agrees with the charged total on a half-cent line, with no balancing article', () => {
    // 1.005 is stored as 1.00499…, so rounding it without the epsilon nudge
    // gives 1.00 while the payment the guest was charged is 1.01.
    const total = roundMoney(1.005);
    expect(total).toBe(1.01);

    const onAdjustment = vi.fn();
    const draft = buildEasyPosCloudInvoiceDraft(
      payload([{ name: 'Espresso', qty: 1, unitPrice: 1.005 }], {
        totalAfter: total,
      }),
      settings,
      { docId: 'inv-rounding-half-cent', onAdjustment },
    );

    // A divergence here shows up as a spurious 1-cent "Adjustment" line.
    expect(draft.articles).toHaveLength(1);
    expect(onAdjustment).not.toHaveBeenCalled();
    expect(draft.payment[0].amount).toBe(total);
  });

  it('files a ticket discount as invoiceRebate, not a negative-price line', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [
          { name: 'Pizza', qty: 3, unitPrice: 9.99 },
          { name: 'Coke', qty: 2, unitPrice: 2.5 },
        ],
        { totalAfter: 30.47, discountAmount: 4.5 },
      ),
      settings,
      { docId: 'inv-payment-matches-lines' },
    );
    expect(draft.articles.every((a) => a.price >= 0)).toBe(true);
    expect(draft.articles.map((a) => a.name)).toEqual(['Pizza', 'Coke']);
    expect(draft.invoiceRebate).toEqual({ inValue: 4.5 });
    expect(draft.payment[0].amount).toBe(30.47);
  });

  it('splits a mixed-VAT shortfall across the bands of the items', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [
          { name: 'Steak', qty: 1, unitPrice: 100, vatRate: 0.2 },
          { name: 'Bread', qty: 1, unitPrice: 50, vatRate: 0.1 },
        ] as any,
        { totalAfter: 180 },
      ),
      settings,
      { docId: 'inv-mixed-shortfall' },
    );
    const adjustments = draft.articles.filter((a) => a.name === 'Adjustment');
    expect(adjustments.map((a) => [a.vatCode, a.price])).toEqual([
      ['B', 20],
      ['D', 10],
    ]);
    expect(draft.payment[0].amount).toBe(180);
  });

  it('puts a mixed-VAT discount on each line instead of one rebate', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [
          { name: 'Steak', qty: 1, unitPrice: 100, vatRate: 0.2 },
          { name: 'Bread', qty: 1, unitPrice: 50, vatRate: 0.1 },
        ] as any,
        { totalAfter: 135, discountAmount: 15 },
      ),
      settings,
      { docId: 'inv-mixed-discount' },
    );
    expect(draft.invoiceRebate).toBeUndefined();
    expect(draft.articles.find((a) => a.name === 'Steak')?.rebate).toEqual({
      inValue: 10,
    });
    expect(draft.articles.find((a) => a.name === 'Bread')?.rebate).toEqual({
      inValue: 5,
    });
    expect(draft.payment[0].amount).toBe(135);
  });

  it('files the service charge on the VAT bands of the goods', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [
          { name: 'Steak', qty: 1, unitPrice: 100, vatRate: 0.2 },
          { name: 'Bread', qty: 1, unitPrice: 100, vatRate: 0.06 },
        ] as any,
        { totalAfter: 220, serviceChargeAmount: 20 },
      ),
      settings,
      { docId: 'inv-service-bands' },
    );
    expect(
      draft.articles
        .filter((a) => a.name === 'Service charge')
        .map((a) => [a.vatCode, a.price]),
    ).toEqual([
      ['B', 10],
      ['E', 10],
    ]);
    expect(draft.payment[0].amount).toBe(220);
  });

  it('files a 0% menu rate at the default band, as the receipt does', () => {
    // 0 means "not set" on the menu; filing it zero-rated declared no VAT
    // on an ordinary drink the receipt showed 20% VAT on.
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [
          { name: 'Coca Cola', qty: 1, unitPrice: 200, vatRate: 0 },
          { name: 'Fanta', qty: 1, unitPrice: 200 },
        ] as any,
        { totalAfter: 400 },
      ),
      settings,
      { docId: 'inv-zero-rate-unset' },
    );
    expect(draft.articles.map((a) => [a.name, a.vatCode])).toEqual([
      ['Coca Cola', 'B'],
      ['Fanta', 'B'],
    ]);
  });

  it('files a shortfall on a reduced-rate item at that rate', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload([{ name: 'Bread', qty: 1, unitPrice: 10, vatRate: 0.1 }] as any, {
        totalAfter: 12,
      }),
      settings,
      { docId: 'inv-single-reduced' },
    );
    expect(draft.articles.map((a) => [a.name, a.vatCode, a.price])).toEqual([
      ['Bread', 'D', 10],
      ['Adjustment', 'D', 2],
    ]);
  });

  it('still balances a genuine gap with rebate, and says so', () => {
    const onAdjustment = vi.fn();
    const draft = buildEasyPosCloudInvoiceDraft(
      payload([{ name: 'Pizza', qty: 1, unitPrice: 10 }], {
        totalAfter: 9,
      }),
      settings,
      { docId: 'inv-balancing-line', onAdjustment },
    );
    expect(draft.articles).toHaveLength(1);
    expect(draft.articles[0].price).toBe(10);
    expect(draft.invoiceRebate).toEqual({ inValue: 1 });
    expect(draft.payment[0].amount).toBe(9);
    expect(onAdjustment).toHaveBeenCalledTimes(1);
  });
});

describe('article IDs', () => {
  const withFallback = {
    ...settings,
    fiscal: { ...(settings as any).fiscal, cloudFallbackArticleId: 'PROD001' },
  } as unknown as SettingsDTO;

  it('keeps a real menu SKU even when a fallback is configured', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [{ sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 150 }] as any,
        {
          totalAfter: 150,
        },
      ),
      withFallback,
      { docId: 'inv-sku-wins' },
    );
    expect(draft.articles[0].articleId).toBe('ESP');
  });

  it('uses the fallback only for lines with no catalog SKU', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload([{ name: 'Espresso', qty: 1, unitPrice: 150 }], {
        totalAfter: 165,
        serviceChargeAmount: 15,
      }),
      withFallback,
      { docId: 'inv-fallback-uncoded' },
    );
    expect(draft.articles.map((a) => a.articleId)).toEqual([
      'PROD001',
      'PROD001',
    ]);
    expect(draft.articles[1].name).toBe('Service charge');
  });

  it('does not invent a catalog ID when no fallback is set', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [{ sku: 'ESP', name: 'Espresso', qty: 1, unitPrice: 150 }] as any,
        {
          totalAfter: 150,
        },
      ),
      settings,
      { docId: 'inv-sku-plain' },
    );
    expect(draft.articles[0].articleId).toBe('ESP');
    expect(draft.operatorCode).toBe('gh537ez280');
  });
});

describe('buildRestatedInvoiceLines', () => {
  const restate = (
    input: Parameters<typeof buildRestatedInvoiceLines>[0],
    s: SettingsDTO = settings,
  ) => {
    const onAdjustment = vi.fn();
    const out = buildRestatedInvoiceLines(input, s, { onAdjustment });
    return { ...out, onAdjustment };
  };

  it('keeps the service charge a corrective invoice used to leave out', () => {
    // 1000 + 500 with a 150 service charge was 1650; the 500 is struck.
    const r = restate({
      items: [
        {
          sku: 'TAVE',
          name: 'Tavë kosi',
          qty: 2,
          unitPrice: 500,
          vatRate: 0.2,
        },
      ],
      serviceChargeAmount: 150,
      total: 1150,
    });
    expect(r.articles.map((a) => [a.name, a.price * a.units])).toEqual([
      ['Tavë kosi', 1000],
      ['Service charge', 150],
    ]);
    expect(r.amount).toBe(1150);
    expect(r.invoiceRebate).toBeUndefined();
    expect(r.onAdjustment).not.toHaveBeenCalled();
  });

  it('carries the discount over as the same rebate', () => {
    const r = restate({
      items: [
        {
          sku: 'TAVE',
          name: 'Tavë kosi',
          qty: 2,
          unitPrice: 500,
          vatRate: 0.2,
        },
      ],
      discountAmount: 150,
      total: 850,
    });
    expect(r.invoiceRebate).toEqual({ inValue: 150 });
    expect(r.amount).toBe(850);
    expect(r.onAdjustment).not.toHaveBeenCalled();
  });

  it('never lets the discount exceed what is left on the invoice', () => {
    const r = restate({
      items: [
        { sku: 'KAFE', name: 'Kafe', qty: 1, unitPrice: 500, vatRate: 0.2 },
      ],
      discountAmount: 1200,
      total: 0,
    });
    expect(r.amount).toBe(0);
    expect(r.articles.every((a) => a.price >= 0)).toBe(true);
  });

  it('always balances the lines against the restated total', () => {
    // An order saved before its service charge was recorded.
    const r = restate({
      items: [
        {
          sku: 'TAVE',
          name: 'Tavë kosi',
          qty: 2,
          unitPrice: 500,
          vatRate: 0.2,
        },
      ],
      total: 1150,
    });
    expect(r.amount).toBe(1150);
    expect(r.onAdjustment).toHaveBeenCalledTimes(1);
  });

  it('uses the same article ids as the original invoice', () => {
    const withFallback = {
      ...settings,
      fiscal: {
        ...(settings as any).fiscal,
        cloudFallbackArticleId: 'PROD001',
      },
    } as unknown as SettingsDTO;
    const r = restate(
      {
        items: [
          {
            sku: 'TAVE',
            name: 'Tavë kosi',
            qty: 1,
            unitPrice: 500,
            vatRate: 0.2,
          },
          { sku: '', name: 'Pa kod', qty: 1, unitPrice: 100, vatRate: 0.2 },
        ],
        serviceChargeAmount: 60,
        total: 660,
      },
      withFallback,
    );
    expect(r.articles.map((a) => a.articleId)).toEqual([
      'TAVE',
      'PROD001',
      'PROD001',
    ]);
  });
});

describe('unit of measure', () => {
  it('files weighed items in KGM and everything else in the default unit', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      payload(
        [
          { name: 'Peshk', qty: 0.35, unitPrice: 4000, soldByKg: true } as any,
          { name: 'Uje', qty: 1, unitPrice: 100 },
        ],
        { totalAfter: 1500 },
      ),
      settings,
      { docId: 'inv-kg-unit' },
    );
    expect(draft.articles.map((a) => [a.name, a.soldIn, a.units])).toEqual([
      ['Peshk', 'KGM', 0.35],
      ['Uje', 'XPP', 1],
    ]);
  });
});

describe('buildCorrectionDifferenceLines — refund below the menu price', () => {
  const settings = {
    defaultVatRate: 0.2,
    fiscal: { enabled: true, defaultSoldIn: 'XPP' },
  } as any;

  it('puts the bill discount on every struck line as a percentage', () => {
    const { articles, amount } = buildCorrectionDifferenceLines(
      [{ name: 'Steak', qty: 1, unitPrice: 1000, vatRate: 0.2 }],
      settings,
      { refund: 900 },
    );
    expect(articles).toMatchObject([
      { name: 'Steak', price: 1000, units: -1, rebate: { inPercentage: 10 } },
    ]);
    expect(amount).toBe(-900);
  });

  it('strikes the service charge share next to the dish', () => {
    const { articles, amount } = buildCorrectionDifferenceLines(
      [{ name: 'Kafe', qty: 1, unitPrice: 500, vatRate: 0.2 }],
      settings,
      { serviceCharge: 50, refund: 550 },
    );
    expect(articles.map((a) => [a.name, a.price, a.units])).toEqual([
      ['Kafe', 500, -1],
      ['Service charge', 50, -1],
    ]);
    expect(articles.every((a) => !a.rebate)).toBe(true);
    expect(amount).toBe(-550);
  });

  it('balances rounding with one line so the document totals the refund', () => {
    // 3 × 333.33 at 12.5% off is 874.99 on easyPos' arithmetic; a refund
    // of 875 needs a cent more.
    const { articles, amount } = buildCorrectionDifferenceLines(
      [{ name: 'A', qty: 3, unitPrice: 333.33, vatRate: 0.2 }],
      settings,
      { refund: 875 },
    );
    expect(amount).toBe(-875);
    expect(articles.at(-1)).toMatchObject({
      name: 'Adjustment',
      price: 0.01,
      units: -1,
    });
  });
});

describe('buildCorrectionDifferenceLines — per VAT band', () => {
  const settings = {
    defaultVatRate: 0.2,
    fiscal: { enabled: true, defaultSoldIn: 'XPP' },
  } as any;
  const steak = { name: 'Steak', qty: 1, unitPrice: 1000, vatRate: 0.2 };
  const wine = { name: 'Wine', qty: 1, unitPrice: 1000, vatRate: 0.06 };

  it('moves a fixed discount onto the band that stays on the bill', () => {
    // 2000 with 200 off, spread 100 / 100 on the original invoice. Refunding
    // the steak gives back 1000 (the discount stays with the bill), so the
    // wine now carries all 200 of it.
    const before = invoiceBandTotals(
      { items: [steak, wine], discountAmount: 200, total: 1800 },
      settings,
    );
    expect(before).toEqual({ B: 900, E: 900 });
    const after = invoiceBandTotals(
      { items: [wine], discountAmount: 200, total: 800 },
      settings,
    );
    const { articles, amount } = buildCorrectionDifferenceLines(
      [steak],
      settings,
      { refund: 1000, bandChange: bandChangeBetween(before, after) },
    );
    expect(amount).toBe(-1000);
    const net = new Map<string, number>();
    for (const a of articles) {
      net.set(a.vatCode, (net.get(a.vatCode) || 0) + a.price * a.units);
    }
    expect(Object.fromEntries(net)).toEqual({ B: -900, E: -100 });
  });
});

describe('fiscalItemName — what the tax service accepts', () => {
  it('keeps Albanian letters and ordinary punctuation', () => {
    expect(fiscalItemName('Tavë kosi "e shtëpisë" – ☕ €')).toBe(
      'Tavë kosi "e shtëpisë" – ☕ €',
    );
  });

  it('cuts at 50 characters (the schema refuses 51)', () => {
    const name = 'Tavë kosi e shtëpisë me mish qengji dhe oriz me perime';
    expect(fiscalItemName(name)).toHaveLength(50);
    expect(fiscalItemName('a'.repeat(50))).toBe('a'.repeat(50));
  });

  it('drops emoji that break the invoice signature', () => {
    expect(fiscalItemName('Tortë 🍰 çokollate')).toBe('Tortë çokollate');
    expect(fiscalItemName('🍰')).toBe('Item');
  });

  it('never ends on half a character', () => {
    const name = fiscalItemName(`${'a'.repeat(49)}ë🍰b`);
    expect(name.length).toBeLessThanOrEqual(50);
    expect(/[\uD800-\uDBFF]$/.test(name)).toBe(false);
  });
});
