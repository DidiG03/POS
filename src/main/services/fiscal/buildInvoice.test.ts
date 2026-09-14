import { describe, expect, it } from 'vitest';
import { buildCorrectiveInvoice } from './buildInvoice';
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
  it('files a cash corrective as NORMAL with iicRef, not P9', () => {
    const request = buildCorrectiveInvoice({
      docId: 'corr-1',
      articles: [article()],
      payment: [{ type: 'CASH', amount: 150 }],
      original: { iic: 'NSLF-ORIG' },
    });
    expect(request.documentType).toBeUndefined();
    expect(request.isEinvoice).toBeUndefined();
    expect(request.correctiveInvoice).toEqual({
      iicRef: 'NSLF-ORIG',
      type: 'CORRECTIVE',
    });
    expect(request.articles).toHaveLength(1);
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
