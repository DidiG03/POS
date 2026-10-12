/**
 * Invoice drafts built from thousands of seeded random tickets.
 *
 * Example tests pin one ticket each. These check the rules every filed
 * invoice must keep, on tickets nobody thought to write down: mixed VAT
 * bands, weighed quantities, discounts, service charge, cents, and charged
 * totals that drift from the lines.
 *
 *   - The invoice adds up to exactly what the guest was charged, and the
 *     payment says the same. (easyPos rejects anything else.)
 *   - The request passes the same validation the send path runs.
 *   - No negative price, no rebate bigger than its line.
 *   - Each VAT band carries its own share of the charge: a discount, a
 *     service charge or a balancing gap is spread over the bands of the
 *     goods, never dumped on one rate.
 *   - Partial voids and restatements keep the same arithmetic.
 */

import { describe, expect, it } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import { roundMoney } from '@shared/pricing';
import {
  buildCorrectionDifferenceLines,
  buildEasyPosCloudInvoiceDraft,
  buildEasyPosInvoiceDraft,
  buildRestatedInvoiceLines,
} from './mapInvoice';
import {
  articleLineTotal,
  computeInvoiceTotal,
  validateRegisterInvoice,
} from './validate';

const cloudSettings = {
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

const localSettings = {
  currency: 'ALL',
  defaultVatRate: 0.2,
  fiscal: {
    baseUrl: 'http://127.0.0.1:8080',
    defaultSoldIn: 'XPP',
    authToken: 'token',
  },
} as unknown as SettingsDTO;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATE_CODE: Record<string, string> = {
  '0.2': 'B',
  '0.1': 'D',
  '0.06': 'E',
};

interface Ticket {
  items: Array<{
    sku: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
    soldByKg?: boolean;
  }>;
  discountAmount: number;
  serviceChargeAmount: number;
  totalAfter: number;
  /** totalAfter minus what the lines, discount and service charge give. */
  drift: number;
}

function randomTicket(random: () => number): Ticket {
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
  const bandMix = pick([
    [0.2],
    [0.2],
    [0.06],
    [0.2, 0.06],
    [0.2, 0.1],
    [0.2, 0.1, 0.06],
  ]);
  const lines = 1 + Math.floor(random() * 6);
  const items: Ticket['items'] = [];
  for (let i = 0; i < lines; i++) {
    const weighed = random() < 0.15;
    const qty = weighed
      ? roundMoney(0.05 + random() * 2.5)
      : 1 + Math.floor(random() * (random() < 0.7 ? 1 : 6));
    const unitPrice =
      random() < 0.8
        ? 10 * (5 + Math.floor(random() * 250))
        : roundMoney(1 + random() * 3000);
    items.push({
      sku: `SKU-${i}`,
      name: `Item ${i}`,
      qty,
      unitPrice,
      vatRate: pick(bandMix),
      ...(weighed ? { soldByKg: true } : {}),
    });
  }
  const goods = roundMoney(
    items.reduce((sum, it) => sum + roundMoney(it.qty * it.unitPrice), 0),
  );
  const discountAmount =
    random() < 0.35 ? roundMoney(goods * (0.02 + random() * 0.5)) : 0;
  const serviceChargeAmount =
    random() < 0.3 ? roundMoney(goods * pick([0.05, 0.1, 0.125])) : 0;
  const drift =
    random() < 0.2
      ? roundMoney((random() < 0.5 ? -1 : 1) * (0.01 + random() * 40))
      : 0;
  const totalAfter = roundMoney(
    Math.max(0.01, goods - discountAmount + serviceChargeAmount + drift),
  );
  return {
    items,
    discountAmount,
    serviceChargeAmount,
    totalAfter,
    drift,
  };
}

function payloadOf(ticket: Ticket) {
  return {
    area: 'Salla',
    tableLabel: '7',
    items: ticket.items,
    meta: {
      method: 'CASH',
      totalAfter: ticket.totalAfter,
      ...(ticket.discountAmount
        ? { discountAmount: ticket.discountAmount }
        : {}),
      ...(ticket.serviceChargeAmount
        ? { serviceChargeAmount: ticket.serviceChargeAmount }
        : {}),
    },
  } as any;
}

/** Net filed per VAT code, after line rebates, before an invoice rebate. */
function bandTotals(articles: Array<any>): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of articles) {
    out.set(
      a.vatCode,
      roundMoney((out.get(a.vatCode) || 0) + articleLineTotal(a)),
    );
  }
  return out;
}

function goodsByBand(ticket: Ticket): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of ticket.items) {
    const code = RATE_CODE[String(it.vatRate)];
    out.set(
      code,
      roundMoney((out.get(code) || 0) + roundMoney(it.qty * it.unitPrice)),
    );
  }
  return out;
}

function describeTicket(seed: number, ticket: Ticket): string {
  return `seed ${seed}: ${JSON.stringify(ticket)}`;
}

describe('cloud invoice drafts for random tickets (seeded)', () => {
  it('always add up to the charged total and pass validation', () => {
    for (let seed = 1; seed <= 4_000; seed++) {
      const ticket = randomTicket(rng(seed));
      const where = describeTicket(seed, ticket);
      const draft = buildEasyPosCloudInvoiceDraft(
        payloadOf(ticket),
        cloudSettings,
        {
          docId: `inv-prop-${seed}`,
        },
      );

      expect(computeInvoiceTotal(draft as any), where).toBe(ticket.totalAfter);
      expect(draft.payment, where).toHaveLength(1);
      expect(draft.payment[0].amount, where).toBe(ticket.totalAfter);
      expect(validateRegisterInvoice(draft as any), where).toEqual([]);

      for (const a of draft.articles) {
        expect(a.price, where).toBeGreaterThanOrEqual(0);
        expect(a.units, where).toBeGreaterThan(0);
        const gross = roundMoney(a.price * a.units);
        const rebate = Number(a.rebate?.inValue || 0);
        expect(rebate, where).toBeGreaterThanOrEqual(0);
        expect(rebate, where).toBeLessThanOrEqual(gross + 1e-9);
      }
    }
  });

  it('keep each VAT band to its own share of the charge', () => {
    for (let seed = 1; seed <= 4_000; seed++) {
      const ticket = randomTicket(rng(seed));
      const where = describeTicket(seed, ticket);
      const draft = buildEasyPosCloudInvoiceDraft(
        payloadOf(ticket),
        cloudSettings,
        {
          docId: `inv-band-${seed}`,
        },
      );
      const goods = goodsByBand(ticket);
      const codes = [...goods.keys()];

      // Only the bands the goods were sold in. A balancing or service line
      // must never introduce a rate nothing was sold at.
      for (const a of draft.articles) {
        expect(codes, where).toContain(a.vatCode);
      }

      if (codes.length === 1) continue;

      // Mixed: no invoice-level rebate (it has no band), and each band's
      // net is its goods' share of what was charged, to within a cent per
      // line in that band.
      expect(draft.invoiceRebate, where).toBeUndefined();
      const goodsTotal = [...goods.values()].reduce((s, v) => s + v, 0);
      const filed = bandTotals(draft.articles);
      for (const code of codes) {
        const expected = (goods.get(code)! / goodsTotal) * ticket.totalAfter;
        const linesInBand = draft.articles.filter(
          (a) => a.vatCode === code,
        ).length;
        expect(
          Math.abs(filed.get(code)! - expected),
          `${where} band ${code}: filed ${filed.get(code)} expected ≈${expected.toFixed(2)}`,
        ).toBeLessThanOrEqual(0.01 * (linesInBand + 1) + 1e-9);
      }
    }
  });

  it('keep weighed items in kilograms and everything else in pieces', () => {
    for (let seed = 1; seed <= 1_000; seed++) {
      const ticket = randomTicket(rng(seed));
      const draft = buildEasyPosCloudInvoiceDraft(
        payloadOf(ticket),
        cloudSettings,
        {
          docId: `inv-kg-${seed}`,
        },
      );
      for (const it of ticket.items) {
        const line = draft.articles.find((a) => a.name === it.name)!;
        expect(line.soldIn, describeTicket(seed, ticket)).toBe(
          it.soldByKg ? 'KGM' : 'XPP',
        );
      }
    }
  });

  it('are byte-identical when built twice from the same ticket', () => {
    // A replay must resend the identical body under the same docId.
    for (let seed = 1; seed <= 500; seed++) {
      const ticket = randomTicket(rng(seed));
      const a = buildEasyPosCloudInvoiceDraft(
        payloadOf(ticket),
        cloudSettings,
        {
          docId: `inv-same-${seed}`,
        },
      );
      const b = buildEasyPosCloudInvoiceDraft(
        payloadOf(ticket),
        cloudSettings,
        {
          docId: `inv-same-${seed}`,
        },
      );
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });
});

describe('local middleware drafts for random tickets (seeded)', () => {
  it('always add up to the charged total', () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const ticket = randomTicket(rng(seed));
      const where = describeTicket(seed, ticket);
      const draft = buildEasyPosInvoiceDraft(payloadOf(ticket), localSettings, {
        docId: `inv-local-${seed}`,
      }) as any;
      const payment = Array.isArray(draft.payment)
        ? draft.payment[0]
        : draft.payment;
      expect(payment.amount, where).toBe(ticket.totalAfter);
      expect(
        computeInvoiceTotal({
          articles: draft.articles,
          invoiceRebate: draft.invoiceRebate,
        }),
        where,
      ).toBe(ticket.totalAfter);
    }
  });
});

describe('corrections for random tickets (seeded)', () => {
  it('a partial void files exactly the struck lines, negated', () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const random = rng(seed);
      const ticket = randomTicket(random);
      const struck = ticket.items.filter((_, i) => i === 0 || random() < 0.4);
      const where = describeTicket(seed, ticket);
      const { articles, amount } = buildCorrectionDifferenceLines(
        struck,
        cloudSettings,
      );
      const struckTotal = roundMoney(
        struck.reduce((s, it) => s + roundMoney(it.qty * it.unitPrice), 0),
      );
      expect(amount, where).toBe(-struckTotal);
      expect(articles, where).toHaveLength(struck.length);
      struck.forEach((it, i) => {
        expect(articles[i].units, where).toBe(-it.qty);
        expect(articles[i].price, where).toBe(it.unitPrice);
        expect(articles[i].vatCode, where).toBe(RATE_CODE[String(it.vatRate)]);
        expect(articles[i].soldIn, where).toBe(it.soldByKg ? 'KGM' : 'XPP');
      });
      // The corrective passes validation against an original IIC.
      expect(
        validateRegisterInvoice({
          docId: `inv-corr-${seed}`,
          articles,
          payment: [{ type: 'CASH', amount }],
          correctiveInvoice: { iicRef: 'A'.repeat(32) },
        } as any),
        where,
      ).toEqual([]);
    }
  });

  it('a restated invoice adds up to the restated total', () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const random = rng(seed);
      const ticket = randomTicket(random);
      if (ticket.items.length < 2) continue;
      const kept = ticket.items.slice(1);
      const keptGoods = roundMoney(
        kept.reduce((s, it) => s + roundMoney(it.qty * it.unitPrice), 0),
      );
      const discount = Math.min(ticket.discountAmount, keptGoods);
      const total = roundMoney(
        Math.max(0.01, keptGoods - discount + ticket.serviceChargeAmount),
      );
      const where = describeTicket(seed, ticket);
      const restated = buildRestatedInvoiceLines(
        {
          items: kept,
          serviceChargeAmount: ticket.serviceChargeAmount,
          discountAmount: ticket.discountAmount,
          total,
        },
        cloudSettings,
      );
      expect(restated.amount, where).toBe(total);
      expect(
        computeInvoiceTotal({
          articles: restated.articles as any,
          invoiceRebate: restated.invoiceRebate,
        }),
        where,
      ).toBe(total);
    }
  });
});
