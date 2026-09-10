import type { SettingsDTO } from '@shared/ipc';
import type { TicketPrintPayload } from '../../print';
import { fiscalConfig } from './config';
import { mapPaymentMethod } from './paymentMethod';
import { assertVatCode } from './vatConfig';
import { buildCurrency } from './buildInvoice';
import { assertValidDocId } from './docId';
import { DEFAULT_CURRENCY, type VatCode } from './apiTypes';
// Deliberately the same rounding the payment total was computed with. A local
// copy without the epsilon nudge disagreed with it on values that land just
// under a half cent (1.005 is stored as 1.00499…), and easyPos rejects an
// invoice whose lines and payment differ by a single cent — the table stays
// open and staff retry the payment.
import { roundMoney } from '@shared/pricing';

export type EasyPosInvoiceDraft = {
  app: string;
  docId?: string;
  articles: Array<{
    articleId: string;
    vatCode: VatCode;
    name: string;
    soldIn: string;
    price: number;
    units: number;
    rebate?: { inPercentage?: number };
  }>;
  payment:
    | { type: string; amount?: number }
    | Array<{ type: string; amount: number }>;
};

export type EasyPosCloudInvoiceDraft = {
  docId: string;
  articles: EasyPosInvoiceDraft['articles'];
  payment: Array<{ type: string; amount: number }>;
  operatorCode?: string;
  currency?: { code: string; exRate?: number };
};

function fiscalArticleSettings(settings: SettingsDTO) {
  const fiscal = (settings as any)?.fiscal || {};
  const config = fiscalConfig(settings);
  return {
    soldIn: String(fiscal.defaultSoldIn || 'XPP').trim() || 'XPP',
    cloudFallbackArticleId: String(fiscal.cloudFallbackArticleId || '').trim(),
    cloud: config.cloud,
    operatorCode: config.operatorCode,
  };
}

function sumArticleTotal(articles: EasyPosInvoiceDraft['articles']): number {
  return roundMoney(
    articles.reduce(
      (sum, article) =>
        sum + Number(article.price || 0) * Number(article.units || 0),
      0,
    ),
  );
}

/**
 * Reported whenever the invoice we are about to file had to be adjusted to
 * match the amount charged. A cent is rounding; anything more means the
 * line items and the total genuinely disagree, and the VAT breakdown filed
 * with the tax service will not match the receipt.
 */
export interface DraftAdjustment {
  articleTotal: number;
  targetTotal: number;
  difference: number;
  vatCode: string;
}

export interface BuildDraftOptions {
  docId?: string;
  onAdjustment?: (info: DraftAdjustment) => void;
}

function reconcileArticlesToTotal(
  articles: EasyPosInvoiceDraft['articles'],
  targetTotal: number,
  settings: SettingsDTO,
  onAdjustment?: (info: DraftAdjustment) => void,
): EasyPosInvoiceDraft['articles'] {
  if (!Number.isFinite(targetTotal) || targetTotal < 0) return articles;
  const soldIn = fiscalArticleSettings(settings).soldIn;
  const current = sumArticleTotal(articles);
  const diff = roundMoney(current - targetTotal);
  if (Math.abs(diff) < 0.01) return articles;

  const vatCode = defaultVatCode(settings);
  // The adjustment carries the DEFAULT rate, so on a mixed-VAT ticket it
  // lands in the wrong band. The totals will balance and easyPos will
  // accept it; the breakdown is what silently goes wrong. Tell someone.
  onAdjustment?.({
    articleTotal: current,
    targetTotal,
    difference: diff,
    vatCode,
  });

  return [
    ...articles,
    {
      articleId: resolveArticleId(
        diff > 0 ? 'POS-DISCOUNT' : 'POS-ADJUSTMENT',
        diff > 0 ? 'Discount' : 'Adjustment',
        settings,
      ),
      vatCode,
      name: diff > 0 ? 'Discount' : 'Adjustment',
      soldIn,
      price: diff > 0 ? -diff : Math.abs(diff),
      units: 1,
    },
  ];
}

/**
 * The band for lines the POS generates itself — service charge, discount,
 * the balancing adjustment. Resolved through the stored VAT configuration
 * like any other line rather than assumed to be the standard rate.
 */
function defaultVatCode(settings: SettingsDTO): VatCode {
  return assertVatCode(settings, {
    vatRate: Number(settings.defaultVatRate) || 0.2,
    articleName: 'POS-generated line',
  });
}

/**
 * The article ID that goes on the wire.
 *
 * A real menu SKU always wins. The "cloud fallback" used to stamp every
 * line with one demo article (PROD001), which on a live venue files the
 * entire menu as a single product. It now applies only when there is no
 * catalog SKU to send: POS-generated lines (service charge, discount,
 * balancing adjustment) and items that were never given a SKU.
 */
function resolveArticleId(
  sku: string,
  name: string,
  settings: SettingsDTO,
): string {
  const { cloud, cloudFallbackArticleId } = fiscalArticleSettings(settings);
  const fromSku = String(sku || '').trim();
  const isCatalogSku = fromSku.length > 0 && !fromSku.startsWith('POS-');
  if (isCatalogSku) return fromSku;
  if (cloud && cloudFallbackArticleId) return cloudFallbackArticleId;
  if (fromSku) return fromSku;
  return `ITEM-${String(name || 'item').slice(0, 24)}`;
}

function buildArticles(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
): EasyPosInvoiceDraft['articles'] {
  const meta: any = payload.meta || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const articles: EasyPosInvoiceDraft['articles'] = [];
  const { soldIn } = fiscalArticleSettings(settings);

  for (const it of items) {
    const qty = Number(it.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    articles.push({
      articleId: resolveArticleId(
        String(it.sku || ''),
        String(it.name || ''),
        settings,
      ),
      // From the stored VAT configuration, and from a code on the item when
      // one is set. Never inferred from the rate by threshold comparison:
      // 0% is A, C or J depending on facts a percentage does not carry.
      vatCode: assertVatCode(settings, {
        vatCode: (it as any).vatCode,
        vatRate: Number(it.vatRate ?? settings.defaultVatRate ?? 0),
        exempt: (it as any).vatExempt === true,
        articleName: String(it.name || 'Item'),
      }),
      name: String(it.name || 'Item').slice(0, 120),
      soldIn,
      price: Number(it.unitPrice || 0),
      units: qty,
    });
  }

  const scAmt = Number(meta.serviceChargeAmount || 0);
  if (Number.isFinite(scAmt) && scAmt > 0) {
    articles.push({
      articleId: resolveArticleId(
        'POS-SERVICE-CHARGE',
        'Service charge',
        settings,
      ),
      vatCode: defaultVatCode(settings),
      name: 'Service charge',
      soldIn,
      price: scAmt,
      units: 1,
    });
  }

  const discountAmt = Number(meta.discountAmount || 0);
  if (Number.isFinite(discountAmt) && discountAmt > 0) {
    articles.push({
      articleId: resolveArticleId('POS-DISCOUNT', 'Discount', settings),
      vatCode: defaultVatCode(settings),
      name: 'Discount',
      soldIn,
      price: -Math.abs(discountAmt),
      units: 1,
    });
  }

  return articles;
}

function buildPaymentArray(
  payload: TicketPrintPayload,
  articles?: EasyPosInvoiceDraft['articles'],
): Array<{ type: string; amount: number }> {
  const meta: any = payload.meta || {};
  const method = mapPaymentMethod(
    String(meta.method || meta.paymentMethod || 'CASH'),
  );
  const articleTotal =
    articles && articles.length ? sumArticleTotal(articles) : undefined;
  const totalAfter = Number(meta.totalAfter);
  const total = Number(meta.total);
  const amountPaid = Number(meta.amountPaid);

  // easyPos requires payment total === sum(article price × units).
  // `amountPaid` is cash tendered (with change), not the invoice total.
  let amount = 0;
  if (articleTotal != null && Number.isFinite(articleTotal)) {
    amount = articleTotal;
  } else if (Number.isFinite(totalAfter) && totalAfter >= 0) {
    amount = totalAfter;
  } else if (Number.isFinite(total) && total > 0) {
    amount = total;
  } else if (Number.isFinite(amountPaid) && amountPaid > 0) {
    amount = amountPaid;
  }

  return [{ type: method, amount: roundMoney(amount) }];
}

/**
 * The docId must already exist and already be persisted.
 *
 * This used to mint a UUID when the caller supplied none, which quietly
 * defeated the entire recovery mechanism: a docId invented at build time is
 * a docId nothing has stored, so a retry builds a *different* one, the
 * status check for it is guaranteed to answer "not found", and the replay
 * files a second invoice for the same sale. Refusing is the only safe
 * behaviour — `fiscalizePaymentOnce` mints and persists one before it gets
 * here.
 */
function ensureDocId(options?: { docId?: string }): string {
  const existing = String(options?.docId || '').trim();
  if (!existing) {
    throw new Error(
      'A docId is required before an invoice can be built. It must be generated once per sale and persisted before the request is sent, so a retry can reuse it.',
    );
  }
  return assertValidDocId(existing);
}

export function buildEasyPosCloudInvoiceDraft(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  options?: BuildDraftOptions,
): EasyPosCloudInvoiceDraft {
  let articles = buildArticles(payload, settings);
  if (articles.length === 0) {
    throw new Error('Cannot fiscalize an empty ticket.');
  }
  const totalAfter = Number((payload.meta as any)?.totalAfter);
  if (Number.isFinite(totalAfter) && totalAfter >= 0) {
    articles = reconcileArticlesToTotal(
      articles,
      totalAfter,
      settings,
      options?.onAdjustment,
    );
  }
  const draft: EasyPosCloudInvoiceDraft = {
    docId: ensureDocId(options),
    articles,
    payment: buildPaymentArray(payload, articles),
  };
  const { operatorCode } = fiscalArticleSettings(settings);
  if (operatorCode) draft.operatorCode = operatorCode;
  // ALL is the default for Albanian fiscalisation and is omitted entirely.
  // This used to default to EUR when `settings.currency` was unset, which
  // sent a foreign-currency invoice for a business selling in lekë.
  const currency = String(settings.currency || DEFAULT_CURRENCY)
    .trim()
    .toUpperCase();
  // Any non-ALL currency needs a rate against ALL — not just EUR. The old
  // code sent `{ code }` with no `exRate` for every other currency, which
  // the API rejects (and which would misvalue the invoice if it did not).
  const built = buildCurrency({
    code: currency,
    exRate: exchangeRateFor(settings, currency),
  });
  if (built) draft.currency = built;
  return draft;
}

/**
 * The configured rate against ALL for a currency.
 *
 * `eurExchangeRate` is the only rate the settings model holds today, so
 * anything else has to be added before that currency can be used —
 * `buildCurrency` turns the missing rate into a clear error rather than an
 * invoice the tax service values wrongly.
 */
function exchangeRateFor(
  settings: SettingsDTO,
  currency: string,
): number | undefined {
  if (currency === DEFAULT_CURRENCY) return undefined;
  const fiscal = (settings as any)?.fiscal || {};
  const perCurrency = fiscal.exchangeRates?.[currency];
  if (Number.isFinite(Number(perCurrency))) return Number(perCurrency);
  if (currency === 'EUR') {
    const eur = Number(fiscal.eurExchangeRate);
    return Number.isFinite(eur) ? eur : undefined;
  }
  return undefined;
}

export function buildEasyPosInvoiceDraft(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  options?: BuildDraftOptions,
): EasyPosInvoiceDraft | EasyPosCloudInvoiceDraft {
  if (fiscalConfig(settings).cloud) {
    return buildEasyPosCloudInvoiceDraft(payload, settings, options);
  }

  const articles = buildArticles(payload, settings);
  if (articles.length === 0) {
    throw new Error('Cannot fiscalize an empty ticket.');
  }

  const meta: any = payload.meta || {};
  const method = mapPaymentMethod(
    String(meta.method || meta.paymentMethod || 'CASH'),
  );
  const totalAfter = Number(meta.totalAfter);
  const total = Number(meta.total);
  const articleTotal = sumArticleTotal(articles);
  const amountDue =
    Number.isFinite(totalAfter) && totalAfter >= 0
      ? totalAfter
      : Number.isFinite(total) && total > 0
        ? total
        : articleTotal;
  const payment =
    Number.isFinite(amountDue) && amountDue > 0
      ? { type: method, amount: roundMoney(amountDue) }
      : { type: method };

  // Unlike the cloud draft this path sends the charged amount as-is rather
  // than forcing the lines to match it. easyPos rejects the invoice when
  // the two disagree, so surface the discrepancy instead of letting the
  // payment fail with an opaque provider error.
  const gap = roundMoney(articleTotal - roundMoney(amountDue));
  if (Number.isFinite(gap) && Math.abs(gap) >= 0.01) {
    options?.onAdjustment?.({
      articleTotal,
      targetTotal: roundMoney(amountDue),
      difference: gap,
      vatCode: defaultVatCode(settings),
    });
  }

  const draft: EasyPosInvoiceDraft = {
    app: 'OneTap POS',
    articles,
    payment,
  };

  const docId = String(options?.docId || '').trim();
  if (docId) draft.docId = docId;

  return draft;
}
