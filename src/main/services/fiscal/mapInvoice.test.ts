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
import { buildEasyPosCloudInvoiceDraft } from './mapInvoice';

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

const articleTotal = (draft: {
  articles: Array<{ price: number; units: number }>;
}) => draft.articles.reduce((sum, a) => sum + a.price * a.units, 0);

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

  it('always sends a payment amount equal to the sum of the article lines', () => {
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
    expect(draft.payment[0].amount).toBeCloseTo(articleTotal(draft), 2);
    expect(draft.payment[0].amount).toBe(30.47);
  });

  it('still balances a genuine gap, and says so', () => {
    const onAdjustment = vi.fn();
    const draft = buildEasyPosCloudInvoiceDraft(
      payload([{ name: 'Pizza', qty: 1, unitPrice: 10 }], {
        totalAfter: 9,
      }),
      settings,
      { docId: 'inv-balancing-line', onAdjustment },
    );
    expect(draft.articles).toHaveLength(2);
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
