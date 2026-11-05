/**
 * QA round 5: what the receipt and the corrective slip print, against what
 * was filed, and settings that must be refused when saved.
 */
import { describe, expect, it } from 'vitest';
import type { SettingsDTO } from '@shared/ipc';
import { roundMoney } from '@shared/pricing';
import { saleCorrectionHttpStatus } from '@shared/saleCorrection';
import { dualTotalsFromSettings } from '@shared/paymentDisplay';
import { buildEasyPosCloudInvoiceDraft, filedLekTotal } from './mapInvoice';
import {
  assertFiscalConfigured,
  fiscalBaseUrlProblem,
  operatorCodesProblem,
} from './config';

const euroVenue = (rate: number) =>
  ({
    currency: 'EUR',
    defaultVatRate: 0.2,
    preferences: { eurExchangeRate: rate },
    fiscal: {
      baseUrl: 'https://api.dev.easypos.al/fiscalisation-service/v1',
      defaultSoldIn: 'XPP',
      defaultOperatorId: 'gh537ez280',
      integrationApp: 'generic',
      authToken: 'jwt',
      eurExchangeRate: rate,
    },
  }) as unknown as SettingsDTO;

const sale = (items: Array<{ name: string; qty: number; unitPrice: number }>) =>
  ({
    area: 'Salla',
    tableLabel: 'T1',
    items: items.map((i) => ({ ...i, vatRate: 0.2 })),
    meta: {
      kind: 'PAYMENT',
      method: 'CASH',
      totalAfter: roundMoney(
        items.reduce((t, i) => t + i.qty * i.unitPrice, 0),
      ),
    },
  }) as any;

describe('F2b: the lekë total on the receipt is the filed one', () => {
  it('equals the payment the invoice declares, where the one-step conversion does not', () => {
    const settings = euroVenue(97.53);
    const payload = sale([
      { name: 'Ujë', qty: 3, unitPrice: 0.35 },
      { name: 'Kafe', qty: 7, unitPrice: 1.15 },
    ]);
    const draft = buildEasyPosCloudInvoiceDraft(payload, settings, {
      docId: 'doc-receipt-1',
    });
    const filed = roundMoney(
      draft.payment.reduce((t, p) => t + Number(p.amount), 0),
    );
    expect(filedLekTotal(payload, settings)).toBe(filed);
    // The receipt's own conversion of the euro total is off by qindarka.
    const oneStep = dualTotalsFromSettings(9.1, settings).lek;
    expect(oneStep).not.toBe(filed);
    expect(Math.abs(Number(oneStep) - filed)).toBeLessThanOrEqual(0.03);
  });

  it('is not stamped for a venue that sells in lekë', () => {
    const settings = { ...euroVenue(1), currency: 'ALL' } as SettingsDTO;
    expect(
      filedLekTotal(sale([{ name: 'Kafe', qty: 1, unitPrice: 150 }]), settings),
    ).toBeNull();
  });
});

describe('QA round 6, #3: three items at 3.333 € on a 10.00 € receipt', () => {
  it('files 980.00 L at 98, the receipt total in lekë, not 979.89 or 980.87', () => {
    const settings = euroVenue(98);
    const payload = sale([
      { name: 'Kafe', qty: 1, unitPrice: 3.333 },
      { name: 'Kafe', qty: 1, unitPrice: 3.333 },
      { name: 'Kafe', qty: 1, unitPrice: 3.333 },
    ]);
    expect(payload.meta.totalAfter).toBe(10);
    const draft = buildEasyPosCloudInvoiceDraft(payload, settings, {
      docId: 'doc-three-dp',
    });
    const filed = roundMoney(
      draft.payment.reduce((t, p) => t + Number(p.amount), 0),
    );
    expect(filed).toBe(980);
    // What the receipt prints in lekë is the filed amount.
    expect(filedLekTotal(payload, settings)).toBe(980);
    // Every filed unit price is the cent price converted.
    for (const a of draft.articles.slice(0, 3)) expect(a.price).toBe(326.34);
  });
});

describe('a gift card payment is filed as the venue maps it', () => {
  it('OTHER by default; never a voucher type, which needs voucher numbers (QA v0.2.103 #4)', () => {
    const payload = {
      ...sale([{ name: 'Kafe', qty: 1, unitPrice: 2 }]),
    };
    payload.meta.method = 'GIFT_CARD';
    const plain = buildEasyPosCloudInvoiceDraft(payload, euroVenue(100), {
      docId: 'doc-gift-1',
    });
    expect(plain.payment.map((p) => p.type)).toEqual(['OTHER']);
    const mapped = (type: string) =>
      ({
        ...euroVenue(100),
        fiscal: {
          ...(euroVenue(100) as any).fiscal,
          paymentTypeMap: { GIFT_CARD: type },
        },
      }) as SettingsDTO;
    // A voucher mapping saved before this is not used: easyPos refused it.
    expect(
      buildEasyPosCloudInvoiceDraft(payload, mapped('SVOUCHER'), {
        docId: 'doc-gift-2',
      }).payment.map((p) => p.type),
    ).toEqual(['OTHER']);
    expect(
      buildEasyPosCloudInvoiceDraft(payload, mapped('COMPANY'), {
        docId: 'doc-gift-3',
      }).payment.map((p) => p.type),
    ).toEqual(['COMPANY']);
  });
});

describe('QA round 6: invoices filed under the paying staff member', () => {
  const withCodes = {
    ...euroVenue(100),
    fiscal: {
      ...(euroVenue(100) as any).fiscal,
      operatorCodes: { '7': 'ab123cd456', '8': 'not-a-code' },
    },
  } as SettingsDTO;
  const paidBy = (userId: number) => {
    const p = sale([{ name: 'Kafe', qty: 1, unitPrice: 2 }]);
    p.meta.userId = userId;
    return p;
  };

  it('uses their own operator code', () => {
    const d = buildEasyPosCloudInvoiceDraft(paidBy(7), withCodes, {
      docId: 'doc-op-7',
    });
    expect(d.operatorCode).toBe('ab123cd456');
  });

  it('falls back to the default without one (or with a malformed one)', () => {
    for (const id of [9, 8]) {
      const d = buildEasyPosCloudInvoiceDraft(paidBy(id), withCodes, {
        docId: `doc-op-${id}`,
      });
      expect(d.operatorCode).toBe('gh537ez280');
    }
  });

  it('a malformed code is refused when saved', () => {
    expect(operatorCodesProblem({ '7': 'ab123' })).toMatch(
      /not an operator code/,
    );
    expect(operatorCodesProblem({ '7': 'ab123cd456', '8': '' })).toBeNull();
  });
});

describe('F6b: a lookalike easyPos address is refused when saved', () => {
  it.each([
    'https://api.easypos.al.example.com/fiscalisation-service/v1',
    'http://api.easypos.al/fiscalisation-service/v1',
    'https://api.easypos.al:8443/fiscalisation-service/v1',
    'https://evil.test/?api.easypos.al',
    'https://user:pw@api.easypos.al/v1',
  ])('%s', (url) => {
    expect(fiscalBaseUrlProblem(url)).toMatch(/not an easyPos Cloud address/);
  });

  it('accepts the easyPos hosts, a local middleware and an empty value', () => {
    expect(
      fiscalBaseUrlProblem('https://api.easypos.al/fiscalisation-service/v1'),
    ).toBeNull();
    expect(
      fiscalBaseUrlProblem(
        'https://api.dev.easypos.al/fiscalisation-service/v1/',
      ),
    ).toBeNull();
    expect(fiscalBaseUrlProblem('http://192.168.1.20:8080')).toBeNull();
    expect(fiscalBaseUrlProblem('')).toBeNull();
    expect(fiscalBaseUrlProblem('not a url')).toMatch(/not a valid address/);
  });

  it('the same check still guards sending', () => {
    const bad = euroVenue(100);
    (bad as any).fiscal.baseUrl = 'https://api.easypos.al.example.com/v1';
    expect(() => assertFiscalConfigured(bad)).toThrow(
      /not an easyPos Cloud address/,
    );
  });
});

describe('F1b: a refused duplicate correction is a conflict', () => {
  it('answers 409 for an invoice or line already reversed', () => {
    expect(saleCorrectionHttpStatus({ ok: false, error: 'already-void' })).toBe(
      409,
    );
    expect(
      saleCorrectionHttpStatus({ ok: false, error: 'line-already-void' }),
    ).toBe(409);
  });

  it('keeps 200 for a success (a repeat of the same key gets the first one)', () => {
    expect(saleCorrectionHttpStatus({ ok: true })).toBe(200);
    expect(
      saleCorrectionHttpStatus({ ok: false, error: 'reason-required' }),
    ).toBe(200);
  });
});

describe('LAN API wiring (QA round 5, F1b, F6b)', () => {
  it('answers a refused duplicate correction and a bad fiscal URL with an error status', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const api = fs.readFileSync(
      path.resolve(__dirname, '../../api.ts'),
      'utf8',
    );
    expect(api).toContain('saleCorrectionHttpStatus(result)');
    // Every settings refusal, a bad fiscal URL included, is a 400
    // (`settingsSaveErrorStatus`, QA v0.2.104 #6).
    expect(api).toMatch(/settingsSaveErrorStatus\(e\) === 400[\s\S]{0,200}400/);
    const { settingsSaveErrorStatus } = await import('../settingsValidation');
    expect(settingsSaveErrorStatus({ code: 'INVALID_FISCAL_URL' })).toBe(400);
  });
});
