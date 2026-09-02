import type { SettingsDTO } from '@shared/ipc';
import type { TicketPrintPayload } from '../../print';
import { isEasyPosCloudApi } from './easypos';
import { mapPaymentMethod, mapVatRateToCode } from './vat';
// Deliberately the same rounding the payment total was computed with. A local
// copy without the epsilon nudge disagreed with it on values that land just
// under a half cent (1.005 is stored as 1.00499…), and easyPos rejects an
// invoice whose lines and payment differ by a single cent — the table stays
// open and staff retry the payment.
import { roundMoney } from '@shared/pricing';

function normalizeCloudOperatorCode(raw: string): string {
  const code = String(raw || '').trim();
  if (code === 'gh537ez200') return 'gh537ez280';
  return code;
}

export type EasyPosInvoiceDraft = {
  app: string;
  docId?: string;
  articles: Array<{
    articleId: string;
    vatCode: string;
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
  return {
    soldIn: String(fiscal.defaultSoldIn || 'XPP').trim() || 'XPP',
    cloudFallbackArticleId: String(fiscal.cloudFallbackArticleId || '').trim(),
    eurExchangeRate: Number(fiscal.eurExchangeRate),
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
  cloud: boolean,
  onAdjustment?: (info: DraftAdjustment) => void,
): EasyPosInvoiceDraft['articles'] {
  if (!Number.isFinite(targetTotal) || targetTotal < 0) return articles;
  const soldIn = fiscalArticleSettings(settings).soldIn;
  const current = sumArticleTotal(articles);
  const diff = roundMoney(current - targetTotal);
  if (Math.abs(diff) < 0.01) return articles;

  const vatCode = mapVatRateToCode(settings.defaultVatRate || 0.2);
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
        cloud,
      ),
      vatCode,
      name: diff > 0 ? 'Discount' : 'Adjustment',
      soldIn,
      price: diff > 0 ? -diff : Math.abs(diff),
      units: 1,
    },
  ];
}

function resolveArticleId(
  sku: string,
  name: string,
  settings: SettingsDTO,
  cloud: boolean,
): string {
  const { cloudFallbackArticleId } = fiscalArticleSettings(settings);
  if (cloud && cloudFallbackArticleId) return cloudFallbackArticleId;
  const fromSku = String(sku || '').trim();
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
  const baseUrl = String((settings as any)?.fiscal?.baseUrl || '');
  const cloud = isEasyPosCloudApi(baseUrl);
  const { soldIn } = fiscalArticleSettings(settings);

  for (const it of items) {
    const qty = Number(it.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    articles.push({
      articleId: resolveArticleId(
        String(it.sku || ''),
        String(it.name || ''),
        settings,
        cloud,
      ),
      vatCode: mapVatRateToCode(
        Number(it.vatRate || settings.defaultVatRate || 0),
      ),
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
        cloud,
      ),
      vatCode: mapVatRateToCode(settings.defaultVatRate || 0.2),
      name: 'Service charge',
      soldIn,
      price: scAmt,
      units: 1,
    });
  }

  const discountAmt = Number(meta.discountAmount || 0);
  if (Number.isFinite(discountAmt) && discountAmt > 0) {
    articles.push({
      articleId: resolveArticleId('POS-DISCOUNT', 'Discount', settings, cloud),
      vatCode: mapVatRateToCode(settings.defaultVatRate || 0.2),
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

function ensureDocId(options?: { docId?: string }): string {
  const existing = String(options?.docId || '').trim();
  if (existing) return existing;
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function buildEasyPosCloudInvoiceDraft(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  options?: BuildDraftOptions,
): EasyPosCloudInvoiceDraft {
  const baseUrl = String((settings as any)?.fiscal?.baseUrl || '');
  const cloud = isEasyPosCloudApi(baseUrl);
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
      cloud,
      options?.onAdjustment,
    );
  }
  const draft: EasyPosCloudInvoiceDraft = {
    docId: ensureDocId(options),
    articles,
    payment: buildPaymentArray(payload, articles),
  };
  const operatorCode = normalizeCloudOperatorCode(
    (settings as any)?.fiscal?.defaultOperatorId ||
      (settings as any)?.fiscal?.operatorCode ||
      '',
  );
  if (operatorCode) draft.operatorCode = operatorCode;
  const currency = String(settings.currency || 'EUR')
    .trim()
    .toUpperCase();
  const { eurExchangeRate } = fiscalArticleSettings(settings);
  if (currency && currency !== 'ALL') {
    if (currency === 'EUR') {
      if (!Number.isFinite(eurExchangeRate) || eurExchangeRate <= 0) {
        throw new Error(
          'EUR exchange rate is required for easyPos cloud. Set "Kursi EUR" in Admin → Fiskalizimi (e.g. 100.5).',
        );
      }
      draft.currency = { code: currency, exRate: eurExchangeRate };
    } else {
      draft.currency = { code: currency };
    }
  }
  return draft;
}

export function buildEasyPosInvoiceDraft(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
  options?: BuildDraftOptions,
): EasyPosInvoiceDraft | EasyPosCloudInvoiceDraft {
  const baseUrl = String((settings as any)?.fiscal?.baseUrl || '');
  if (isEasyPosCloudApi(baseUrl)) {
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
      vatCode: mapVatRateToCode(settings.defaultVatRate || 0.2),
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
