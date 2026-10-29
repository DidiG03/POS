/**
 * QA F2: with EUR→ALL at 97.37 a €74.82 bill was refused every time
 * ("7285.23/7285.22") and the table could not be paid. easyPos converted
 * the euro lines and the euro payment on its own and rounded them apart.
 * The invoice is now converted to lekë here, line by line, and the payment
 * is derived from those lines, so they add up exactly at any rate.
 */
import { describe, expect, it } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import { roundMoney } from '@shared/pricing';
import { buildEasyPosCloudInvoiceDraft, invoiceInLek } from './mapInvoice';
import {
  computeInvoiceTotal,
  sumPayments,
  validateRegisterInvoice,
} from './validate';

const euroVenue = (rate: number) =>
  ({
    currency: 'EUR',
    defaultVatRate: 0.2,
    fiscal: {
      baseUrl: 'https://api.dev.easypos.al/fiscalisation-service/v1',
      defaultSoldIn: 'XPP',
      defaultOperatorId: 'gh537ez280',
      integrationApp: 'generic',
      authToken: 'jwt',
      eurExchangeRate: rate,
    },
  }) as unknown as SettingsDTO;

type Line = {
  name: string;
  qty: number;
  unitPrice: number;
  vatRate?: number;
  soldByKg?: boolean;
};

function bill(items: Line[], meta: Record<string, unknown> = {}) {
  const gross = roundMoney(
    items.reduce((t, it) => t + it.qty * it.unitPrice, 0),
  );
  const sc = Number(meta.serviceChargeAmount || 0);
  const discount = Number(meta.discountAmount || 0);
  return {
    area: 'Salla',
    tableLabel: 'T1',
    items,
    meta: {
      method: 'CASH',
      totalAfter: roundMoney(gross + sc - discount),
      ...meta,
    },
  } as any;
}

const RATES = [97.37, 98, 100.25, 103.9, 96.481, 117.13];

const BILLS: Array<{ label: string; payload: any }> = [
  {
    label: 'QA bill (€74.82)',
    payload: bill([
      { name: 'Pizza', qty: 2, unitPrice: 12.9 },
      { name: 'Wine', qty: 1, unitPrice: 24.5 },
      { name: 'Water', qty: 3, unitPrice: 2.5 },
      { name: 'Tiramisu', qty: 2, unitPrice: 6.21 },
      { name: 'Espresso', qty: 2, unitPrice: 2.3 },
    ]),
  },
  {
    label: 'mixed 20% and 10% VAT',
    payload: bill([
      { name: 'Steak', qty: 1, unitPrice: 23.45, vatRate: 0.2 },
      { name: 'Bread', qty: 3, unitPrice: 1.15, vatRate: 0.1 },
      { name: 'Cola', qty: 2, unitPrice: 2.85, vatRate: 0.2 },
    ]),
  },
  {
    label: 'mixed VAT with a discount',
    payload: bill(
      [
        { name: 'Steak', qty: 1, unitPrice: 23.45, vatRate: 0.2 },
        { name: 'Bread', qty: 3, unitPrice: 1.15, vatRate: 0.1 },
      ],
      { discountAmount: 3.33 },
    ),
  },
  {
    label: 'service charge',
    payload: bill(
      [
        { name: 'Pasta', qty: 1, unitPrice: 11.9, vatRate: 0.2 },
        { name: 'Bread', qty: 1, unitPrice: 1.15, vatRate: 0.1 },
      ],
      { serviceChargeAmount: 1.31 },
    ),
  },
  {
    label: 'weighed fish',
    payload: bill([
      { name: 'Sea bass', qty: 0.735, unitPrice: 48.9, soldByKg: true },
      { name: 'Salad', qty: 1, unitPrice: 6.6 },
    ]),
  },
];

describe('euro venue, decimal exchange rates (QA F2)', () => {
  for (const rate of RATES) {
    for (const { label, payload } of BILLS) {
      it(`${label} at ${rate}: lines, total and payment agree`, () => {
        const draft = buildEasyPosCloudInvoiceDraft(payload, euroVenue(rate), {
          docId: 'inv-rate-test',
        });
        // Filed in lekë: easyPos converts nothing, so it rounds nothing.
        expect(draft.currency).toBeUndefined();
        const total = computeInvoiceTotal(draft as any);
        expect(sumPayments(draft.payment as any)).toBe(total);
        expect(validateRegisterInvoice(draft as any)).toEqual([]);
        // Within rounding of the euro charge converted as a whole: half a
        // euro cent per line (the euro bill was rounded before conversion).
        const charged = Number(payload.meta.totalAfter) * rate;
        expect(Math.abs(total - charged)).toBeLessThan(
          0.005 * rate * draft.articles.length + 0.01,
        );
        // Every converted price is a whole number of qindarka.
        for (const a of draft.articles) {
          expect(Math.round(a.price * 100) / 100).toBe(a.price);
        }
      });
    }
  }

  it('files the QA €74.82 bill at 97.37 with the payment equal to its lines', () => {
    const draft = buildEasyPosCloudInvoiceDraft(
      BILLS[0].payload,
      euroVenue(97.37),
      { docId: 'inv-qa-74-82' },
    );
    expect(BILLS[0].payload.meta.totalAfter).toBe(74.82);
    expect(draft.payment).toEqual([
      { type: 'CASH', amount: computeInvoiceTotal(draft as any) },
    ]);
  });

  it('leaves a lekë venue untouched', () => {
    const lekVenue = { ...euroVenue(97.37), currency: 'ALL' } as SettingsDTO;
    const articles = [
      {
        articleId: 'A',
        vatCode: 'VAT_20' as any,
        name: 'Byrek',
        soldIn: 'XPP',
        price: 250,
        units: 2,
      },
    ];
    const out = invoiceInLek(articles, undefined, lekVenue);
    expect(out).toEqual({ articles, amount: 500, rate: null });
  });

  it('refuses a euro invoice with no rate instead of misvaluing it', () => {
    const noRate = euroVenue(Number.NaN);
    expect(() =>
      buildEasyPosCloudInvoiceDraft(BILLS[0].payload, noRate, {
        docId: 'inv-no-rate',
      }),
    ).toThrow(/exchange rate/);
  });
});
