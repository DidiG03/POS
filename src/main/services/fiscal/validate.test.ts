/**
 * Client-side validation.
 *
 * Each rule here exists to turn a post-payment provider rejection into a
 * pre-send local error. A rejection here is always safe — nothing was
 * sent, so nothing was filed and the docId is still unused.
 */

import { describe, expect, it } from 'vitest';
import {
  computeInvoiceTotal,
  validateCancelInvoice,
  validateRegisterInvoice,
} from './validate';
import type { InvoiceArticle, RegisterInvoiceRequest } from './apiTypes';

const article = (over: Partial<InvoiceArticle> = {}): InvoiceArticle => ({
  articleId: 'ESP',
  vatCode: 'B' as const,
  name: 'Espresso',
  soldIn: 'XPP',
  price: 100,
  units: 2,
  ...over,
});

const base = (
  over: Partial<RegisterInvoiceRequest> = {},
): RegisterInvoiceRequest => ({
  docId: 'inv-validate-1',
  articles: [article()],
  payment: [{ type: 'CASH', amount: 200 }],
  ...over,
});

/** Field paths of the issues raised, for concise assertions. */
const fields = (request: RegisterInvoiceRequest) =>
  validateRegisterInvoice(request).map((i) => i.field);

describe('a valid NORMAL invoice', () => {
  it('raises nothing', () => {
    expect(validateRegisterInvoice(base())).toEqual([]);
  });

  it('omits documentType rather than setting NORMAL', () => {
    expect(base().documentType).toBeUndefined();
  });
});

describe('docId', () => {
  it('is checked here so the failure is local', () => {
    expect(fields(base({ docId: 'ab' }))).toContain('docId');
    expect(fields(base({ docId: '' }))).toContain('docId');
  });
});

describe('articles', () => {
  it('are required with at least one entry', () => {
    expect(fields(base({ articles: [] }))).toContain('articles');
    expect(fields(base({ articles: undefined }))).toContain('articles');
  });

  it('reject an unknown VAT code', () => {
    expect(
      fields(base({ articles: [article({ vatCode: 'Z' as any })] })),
    ).toContain('articles[0].vatCode');
  });

  it('require a unit of measure and a positive quantity', () => {
    expect(fields(base({ articles: [article({ soldIn: '' })] }))).toContain(
      'articles[0].soldIn',
    );
    expect(fields(base({ articles: [article({ units: 0 })] }))).toContain(
      'articles[0].units',
    );
  });

  it('must be absent on a SUMMARY', () => {
    const issues = fields(
      base({
        documentType: 'SUMMARY',
        articles: [article()],
        summaryInvoices: [{ iic: 'A1' }],
        total: 200,
      }),
    );
    expect(issues).toContain('articles');
  });
});

describe('payment', () => {
  it('is required except on an ORDER', () => {
    expect(fields(base({ payment: [] }))).toContain('payment');
    expect(fields(base({ payment: undefined }))).toContain('payment');
  });

  it('must sum exactly to the invoice total', () => {
    const issues = validateRegisterInvoice(
      base({ payment: [{ type: 'CASH', amount: 199 }] }),
    );
    expect(issues[0]?.field).toBe('payment');
    expect(issues[0]?.message).toMatch(
      /total 199.00 but the invoice total is 200.00/,
    );
  });

  it('accepts a split across methods that adds up', () => {
    expect(
      validateRegisterInvoice(
        base({
          payment: [
            { type: 'CASH', amount: 150 },
            { type: 'CARD', amount: 50 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('tolerates a cent of rounding but not two', () => {
    expect(
      validateRegisterInvoice(
        base({ payment: [{ type: 'CASH', amount: 200.01 }] }),
      ),
    ).toEqual([]);
    expect(
      fields(base({ payment: [{ type: 'CASH', amount: 200.02 }] })),
    ).toContain('payment');
  });

  describe('type ACCOUNT', () => {
    const account = (details?: any) =>
      base({ payment: [{ type: 'ACCOUNT', amount: 200, details }] });

    it('requires a non-empty details array', () => {
      expect(fields(account(undefined))).toContain('payment[0].details');
      expect(fields(account([]))).toContain('payment[0].details');
    });

    it('requires all seven fields on every entry', () => {
      const issues = fields(account([{ idNumber: 'X', name: 'Y' }]));
      for (const field of [
        'bankName',
        'swift_code',
        'country',
        'countryCode',
        'currency',
      ]) {
        expect(issues).toContain(`payment[0].details[0].${field}`);
      }
      expect(issues).not.toContain('payment[0].details[0].idNumber');
    });

    it('accepts a complete entry', () => {
      expect(
        validateRegisterInvoice(
          account([
            {
              idNumber: 'L41323029B',
              name: 'Acme',
              bankName: 'BKT',
              swift_code: 'NCBAALTX',
              country: 'Albania',
              countryCode: 'AL',
              currency: 'ALL',
            },
          ]),
        ),
      ).toEqual([]);
    });
  });
});

describe('ORDER', () => {
  it('accepts articles with no payment key at all', () => {
    expect(
      validateRegisterInvoice({
        docId: 'inv-order-1',
        documentType: 'ORDER',
        articles: [article()],
      }),
    ).toEqual([]);
  });

  it('refuses even an empty payment array', () => {
    // An empty array is a payment array, and it fails the total check.
    // Absence is what makes the API generate the document as an order.
    const issues = validateRegisterInvoice({
      docId: 'inv-order-2',
      documentType: 'ORDER',
      articles: [article()],
      payment: [],
    });
    expect(issues.map((i) => i.field)).toContain('payment');
    expect(issues[0]?.message).toMatch(/omit payment entirely/);
  });
});

describe('SUMMARY', () => {
  const summary = (over: Partial<RegisterInvoiceRequest> = {}) => ({
    docId: 'inv-summary-1',
    documentType: 'SUMMARY' as const,
    summaryInvoices: [{ iic: 'A1' }],
    total: 200,
    payment: [{ type: 'CASH' as const, amount: 200 }],
    ...over,
  });

  it('is valid with references, a total and a payment', () => {
    expect(validateRegisterInvoice(summary())).toEqual([]);
  });

  it('requires at least one referenced IIC', () => {
    expect(fields(summary({ summaryInvoices: [] }))).toContain(
      'summaryInvoices',
    );
    expect(fields(summary({ summaryInvoices: [{ iic: '' }] }))).toContain(
      'summaryInvoices[0].iic',
    );
  });

  it('requires a stated total', () => {
    expect(fields(summary({ total: undefined }))).toContain('total');
  });

  it('checks the payment against the stated total, not against articles', () => {
    expect(
      fields(summary({ total: 200, payment: [{ type: 'CASH', amount: 150 }] })),
    ).toContain('payment');
  });
});

describe('SELFISSUE', () => {
  const buyer = {
    buyerIDType: 'NUIS' as const,
    buyerID: 'L41323029B',
    name: 'Supplier Ltd',
  };

  it('requires selfIssueType, buyer and an explicit reverseCharge', () => {
    const issues = fields({
      docId: 'inv-self-1',
      documentType: 'SELFISSUE',
      articles: [article()],
      payment: [{ type: 'CASH', amount: 200 }],
    });
    expect(issues).toContain('selfIssueType');
    expect(issues).toContain('reverseCharge');
    expect(issues).toContain('buyer');
  });

  it('is valid once all three are present', () => {
    expect(
      validateRegisterInvoice({
        docId: 'inv-self-2',
        documentType: 'SELFISSUE',
        articles: [article()],
        payment: [{ type: 'CASH', amount: 200 }],
        selfIssueType: 'PURCHASE',
        reverseCharge: false,
        buyer,
      }),
    ).toEqual([]);
  });
});

describe('EXPORT', () => {
  const exp = (over: Partial<RegisterInvoiceRequest> = {}) => ({
    docId: 'inv-export-1',
    documentType: 'EXPORT' as const,
    articles: [article({ vatCode: 'J' as const })],
    payment: [{ type: 'CASH' as const, amount: 200 }],
    buyer: {
      buyerIDType: 'VAT' as const,
      buyerID: 'IT12345678',
      name: 'Roma Srl',
      countryCode: 'IT',
    },
    supplyPeriod: { start: '2026-09-01', end: '2026-09-30' },
    ...over,
  });

  it('is valid with a foreign buyer, a supply period and vatCode J', () => {
    expect(validateRegisterInvoice(exp())).toEqual([]);
  });

  it('requires the export VAT code on every line', () => {
    expect(fields(exp({ articles: [article({ vatCode: 'B' })] }))).toContain(
      'articles[0].vatCode',
    );
  });

  it('requires a supply period', () => {
    expect(fields(exp({ supplyPeriod: undefined }))).toContain('supplyPeriod');
  });

  it('refuses a domestic buyer', () => {
    expect(
      fields(
        exp({
          buyer: {
            buyerIDType: 'NUIS',
            buyerID: 'L41323029B',
            name: 'Local',
            countryCode: 'AL',
          },
        }),
      ),
    ).toContain('buyer.countryCode');
  });
});

describe('buyer', () => {
  it('is required for an electronic invoice', () => {
    expect(fields(base({ isEinvoice: true, selectedProcess: 'P1' }))).toContain(
      'buyer',
    );
  });

  it('validates a NUIS against the pattern', () => {
    const withNuis = (buyerID: string) =>
      fields(
        base({
          isEinvoice: true,
          selectedProcess: 'P1',
          buyer: { buyerIDType: 'NUIS', buyerID, name: 'Acme' },
        }),
      );
    expect(withNuis('L41323029B')).toEqual([]);
    // Lower case is normalised by the builder, so it must validate too.
    expect(withNuis('l41323029b')).toEqual([]);
    expect(withNuis('41323029B')).toContain('buyer.buyerID');
    expect(withNuis('L4132302B')).toContain('buyer.buyerID');
    expect(withNuis('LL1323029B')).toContain('buyer.buyerID');
  });

  it('does not apply the NUIS pattern to other id types', () => {
    expect(
      fields(
        base({
          isEinvoice: true,
          selectedProcess: 'P1',
          buyer: {
            buyerIDType: 'PASS',
            buyerID: 'AB1234567',
            name: 'Traveller',
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe('electronic processes', () => {
  const e = (over: Partial<RegisterInvoiceRequest> = {}) =>
    base({
      isEinvoice: true,
      buyer: { buyerIDType: 'NUIS', buyerID: 'L41323029B', name: 'Acme' },
      ...over,
    });

  it('require a selectedProcess', () => {
    expect(fields(e())).toContain('selectedProcess');
  });

  it('require isEinvoice when a process is named', () => {
    expect(fields(base({ selectedProcess: 'P1' }))).toContain('isEinvoice');
  });

  describe('P4', () => {
    it('requires prepaidAmount', () => {
      expect(fields(e({ selectedProcess: 'P4' }))).toContain('prepaidAmount');
    });

    it('rejects zero or negative', () => {
      expect(fields(e({ selectedProcess: 'P4', prepaidAmount: 0 }))).toContain(
        'prepaidAmount',
      );
    });

    it('rejects more than the invoice total', () => {
      const issues = validateRegisterInvoice(
        e({ selectedProcess: 'P4', prepaidAmount: 250 }),
      );
      expect(issues[0]?.message).toMatch(/must not exceed the invoice total/i);
    });

    it('accepts a prepayment up to the total', () => {
      expect(
        validateRegisterInvoice(
          e({ selectedProcess: 'P4', prepaidAmount: 200 }),
        ),
      ).toEqual([]);
      expect(
        validateRegisterInvoice(
          e({ selectedProcess: 'P4', prepaidAmount: 50 }),
        ),
      ).toEqual([]);
    });
  });

  it('rejects prepaidAmount on any other process', () => {
    expect(fields(e({ selectedProcess: 'P1', prepaidAmount: 50 }))).toContain(
      'prepaidAmount',
    );
    expect(fields(base({ prepaidAmount: 50 }))).toContain('prepaidAmount');
  });

  it.each(['P9', 'P10'] as const)(
    '%s requires correctiveInvoice.iicRef',
    (p) => {
      expect(fields(e({ selectedProcess: p }))).toContain(
        'correctiveInvoice.iicRef',
      );
      expect(
        validateRegisterInvoice(
          e({ selectedProcess: p, correctiveInvoice: { iicRef: 'A1' } }),
        ),
      ).toEqual([]);
    },
  );

  it('accepts P11 partial/final invoicing with no extra fields', () => {
    expect(validateRegisterInvoice(e({ selectedProcess: 'P11' }))).toEqual([]);
  });
});

describe('invoiceRebate', () => {
  it('refuses both forms at once', () => {
    const issues = validateRegisterInvoice(
      base({
        invoiceRebate: { inPercentage: 10, inValue: 5 },
        payment: [{ type: 'CASH', amount: 180 }],
      }),
    );
    expect(issues.map((i) => i.field)).toContain('invoiceRebate');
    expect(issues.find((i) => i.field === 'invoiceRebate')?.message).toMatch(
      /mutually exclusive/,
    );
  });

  it('accepts a percentage, and the payment must match the reduced total', () => {
    expect(
      validateRegisterInvoice(
        base({
          invoiceRebate: { inPercentage: 10 },
          payment: [{ type: 'CASH', amount: 180 }],
        }),
      ),
    ).toEqual([]);
  });

  it('applies the same rule to a line rebate', () => {
    expect(
      fields(
        base({
          articles: [article({ rebate: { inPercentage: 5, inValue: 1 } })],
        }),
      ),
    ).toContain('articles[0].rebate');
  });
});

describe('currency', () => {
  it('needs no exchange rate for ALL', () => {
    expect(
      validateRegisterInvoice(base({ currency: { code: 'ALL' } })),
    ).toEqual([]);
  });

  it('requires an exchange rate for any other currency', () => {
    expect(fields(base({ currency: { code: 'EUR' } }))).toContain(
      'currency.exRate',
    );
    expect(fields(base({ currency: { code: 'USD', exRate: 0 } }))).toContain(
      'currency.exRate',
    );
    expect(
      validateRegisterInvoice(
        base({ currency: { code: 'EUR', exRate: 100.5 } }),
      ),
    ).toEqual([]);
  });
});

describe('operatorCode', () => {
  it('accepts the issued format', () => {
    expect(
      validateRegisterInvoice(base({ operatorCode: 'gh537ez280' })),
    ).toEqual([]);
  });

  it('rejects anything else, and points at get-operators', () => {
    const issues = validateRegisterInvoice(
      base({ operatorCode: 'GH537EZ280' }),
    );
    expect(issues[0]?.field).toBe('operatorCode');
    expect(issues[0]?.message).toMatch(/get-operators/);
    expect(fields(base({ operatorCode: 'gh537ez28' }))).toContain(
      'operatorCode',
    );
    expect(fields(base({ operatorCode: 'abc123' }))).toContain('operatorCode');
  });
});

describe('computeInvoiceTotal', () => {
  it('sums the lines', () => {
    expect(
      computeInvoiceTotal({ articles: [article(), article({ price: 50 })] }),
    ).toBe(300);
  });

  it('applies a line rebate before the invoice total', () => {
    expect(
      computeInvoiceTotal({
        articles: [article({ rebate: { inPercentage: 50 } })],
      }),
    ).toBe(100);
    expect(
      computeInvoiceTotal({ articles: [article({ rebate: { inValue: 20 } })] }),
    ).toBe(180);
  });

  it('applies the invoice rebate after the lines', () => {
    expect(
      computeInvoiceTotal({
        articles: [article()],
        invoiceRebate: { inPercentage: 10 },
      }),
    ).toBe(180);
  });

  it('takes a SUMMARY total as stated', () => {
    expect(
      computeInvoiceTotal({
        documentType: 'SUMMARY',
        total: 425.5,
        articles: [],
      }),
    ).toBe(425.5);
  });
});

describe('validateCancelInvoice', () => {
  it('requires the referenced IIC', () => {
    const issues = validateCancelInvoice({
      docId: 'cnl-1234567',
      correctiveInvoice: { iicRef: '' },
    });
    expect(issues.map((i) => i.field)).toContain('correctiveInvoice.iicRef');
  });

  it('is valid for a plain cancellation', () => {
    expect(
      validateCancelInvoice({
        docId: 'cnl-1234567',
        correctiveInvoice: { iicRef: 'A1' },
      }),
    ).toEqual([]);
  });

  it('requires P10 for an electronic cancellation', () => {
    expect(
      validateCancelInvoice({
        docId: 'cnl-1234567',
        correctiveInvoice: { iicRef: 'A1' },
        isEinvoice: true,
        selectedProcess: 'P9',
      }).map((i) => i.field),
    ).toContain('selectedProcess');

    expect(
      validateCancelInvoice({
        docId: 'cnl-1234567',
        correctiveInvoice: { iicRef: 'A1' },
        isEinvoice: true,
        selectedProcess: 'P10',
      }),
    ).toEqual([]);
  });

  it('refuses an electronic process on a non-electronic cancellation', () => {
    expect(
      validateCancelInvoice({
        docId: 'cnl-1234567',
        correctiveInvoice: { iicRef: 'A1' },
        selectedProcess: 'P10',
      }).map((i) => i.field),
    ).toContain('selectedProcess');
  });
});
