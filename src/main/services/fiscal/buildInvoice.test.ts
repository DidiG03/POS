import { describe, expect, it } from 'vitest';
import { buildCorrectiveInvoice, buildNormalInvoice } from './buildInvoice';
import type { InvoiceArticle } from './apiTypes';

const article = (over: Partial<InvoiceArticle> = {}): InvoiceArticle => ({
  articleId: 'ESP',
  vatCode: 'B',
  name: 'Espresso',
  soldIn: 'XPP',
  price: 150,
  units: 1,
  ...over,
});

describe('buildCorrectiveInvoice', () => {
  it('files a cash corrective as NORMAL with iicRef only, not P9', () => {
    // The shape the easyPos sandbox accepted on 2026-10-12: the struck line
    // with negative units and a negative payment. `type` and
    // `issueDateTimeRef` were refused as "Unknown fields found".
    const request = buildCorrectiveInvoice({
      docId: 'corr-1',
      articles: [{ ...article(), units: -1 }],
      payment: [{ type: 'CASH', amount: -150 }],
      original: {
        iic: 'NSLF-ORIG',
        issueDateTime: '2026-10-12T01:33:04+02:00',
      },
    });
    expect(request.documentType).toBeUndefined();
    expect(request.isEinvoice).toBeUndefined();
    expect(request.correctiveInvoice).toEqual({ iicRef: 'NSLF-ORIG' });
    expect(request.articles).toHaveLength(1);
  });

  it('allows negative units only on a corrective invoice', () => {
    expect(() =>
      buildNormalInvoice({
        docId: 'normal-neg',
        articles: [{ ...article(), units: -1 }],
        payment: [{ type: 'CASH', amount: -150 }],
      }),
    ).toThrow(/units/);
  });

  it('refuses P9 when the original is electronic but the buyer is missing', () => {
    expect(() =>
      buildCorrectiveInvoice({
        docId: 'corr-2',
        articles: [article()],
        payment: [{ type: 'CASH', amount: 150 }],
        original: { iic: 'NSLF-ORIG', eic: 'EIC-1' },
      }),
    ).toThrow(/P9/);
  });
});
