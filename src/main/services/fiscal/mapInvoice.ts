import type { SettingsDTO } from '@shared/ipc';
import type { TicketPrintPayload } from '../../print';
import { fiscalConfig } from './config';
import { mapPaymentMethod } from './paymentMethod';
import { assertVatCode } from './vatConfig';
import { buildCurrency } from './buildInvoice';
import { assertValidDocId } from './docId';
import { DEFAULT_CURRENCY, type Rebate, type VatCode } from './apiTypes';
import { articleLineTotal, computeInvoiceTotal } from './validate';
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
    rebate?: Rebate;
  }>;
  payment:
    | { type: string; amount?: number }
    | Array<{ type: string; amount: number }>;
  invoiceRebate?: Rebate;
};

export type EasyPosCloudInvoiceDraft = {
  docId: string;
  articles: EasyPosInvoiceDraft['articles'];
  payment: Array<{ type: string; amount: number }>;
  operatorCode?: string;
  currency?: { code: string; exRate?: number };
  invoiceRebate?: Rebate;
};

/** UN/CEFACT code for kilogram, per the easyPos `soldIn` field. */
export const SOLD_BY_KG_UNIT = 'KGM';

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

function invoiceTotalOf(
  articles: EasyPosInvoiceDraft['articles'],
  invoiceRebate?: Rebate,
): number {
  return computeInvoiceTotal({ articles, invoiceRebate });
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
  /** The item bands the gap was filed on, joined for the admin alert. */
  vatCode: string;
}

export interface BuildDraftOptions {
  docId?: string;
  onAdjustment?: (info: DraftAdjustment) => void;
}

function ticketDiscountRebate(payload: TicketPrintPayload): Rebate | undefined {
  const discountAmt = Number((payload.meta as any)?.discountAmount || 0);
  if (!Number.isFinite(discountAmt) || discountAmt <= 0) return undefined;
  return { inValue: roundMoney(discountAmt) };
}

/**
 * Split `amount` across `weights` so the parts sum to the amount exactly.
 *
 * Largest-remainder on cents. A proportional split that rounds each share
 * on its own drops or adds a cent, and easyPos rejects that invoice.
 */
function allocateMoney(amount: number, weights: number[]): number[] {
  const cents = Math.round(roundMoney(amount) * 100);
  if (cents <= 0 || weights.length === 0) return weights.map(() => 0);
  const sum = weights.reduce((total, weight) => total + Math.max(0, weight), 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const exacts = weights.map((weight) =>
    weight > 0 ? (cents * weight) / sum : 0,
  );
  const floors = exacts.map((exact) => Math.floor(exact + 1e-9));
  let remain = cents - floors.reduce((total, value) => total + value, 0);
  const order = exacts
    .map((exact, index) => ({ index, frac: exact - floors[index] }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  const out = floors.slice();
  for (let i = 0; i < remain; i++) out[order[i % order.length].index] += 1;
  return out.map((value) => value / 100);
}

function positiveBands(
  articles: EasyPosInvoiceDraft['articles'],
): Array<{ code: VatCode; weight: number }> {
  const weights = new Map<VatCode, number>();
  for (const article of articles) {
    const gross = articleLineTotal(article);
    if (!(gross > 0)) continue;
    weights.set(article.vatCode, (weights.get(article.vatCode) || 0) + gross);
  }
  return [...weights.entries()].map(([code, weight]) => ({ code, weight }));
}

function bandLabel(codes: string[]): string {
  if (codes.length <= 1) return codes[0] || '';
  if (codes.length === 2) return `${codes[0]} and ${codes[1]}`;
  return `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}`;
}

/**
 * Put a discount on the lines that earned it, in proportion to each line,
 * so a 20% item and a 6% item each keep their own VAT base.
 */
function addLineRebates(
  articles: EasyPosInvoiceDraft['articles'],
  amount: number,
): EasyPosInvoiceDraft['articles'] {
  let left = roundMoney(amount);
  let current = articles.map((article) => ({ ...article }));
  for (let pass = 0; pass < 4 && left >= 0.01; pass++) {
    const room = current.map((article) => {
      const gross = roundMoney(
        Number(article.price || 0) * Number(article.units || 0),
      );
      const taken = roundMoney(Number(article.rebate?.inValue || 0));
      return Math.max(0, roundMoney(gross - taken));
    });
    const budget = Math.min(
      left,
      roundMoney(room.reduce((total, value) => total + value, 0)),
    );
    if (budget < 0.01) break;
    const shares = allocateMoney(budget, room);
    current = current.map((article, index) => {
      if (shares[index] < 0.01) return article;
      const prev = Number(article.rebate?.inValue || 0);
      return {
        ...article,
        rebate: { inValue: roundMoney(prev + shares[index]) },
      };
    });
    left = roundMoney(left - shares.reduce((total, value) => total + value, 0));
  }
  return current;
}

/**
 * Make the invoice total equal the amount charged without negative prices.
 *
 * One VAT band keeps a ticket discount as `invoiceRebate`. Mixed bands get
 * a rebate on each line, in proportion to that line, so the tax service is
 * not told the whole discount belonged to the default rate. A shortfall is
 * an adjustment line per band of the goods, not one line at the default rate.
 */
function reconcileToChargedTotal(
  articles: EasyPosInvoiceDraft['articles'],
  invoiceRebate: Rebate | undefined,
  targetTotal: number,
  settings: SettingsDTO,
  onAdjustment?: (info: DraftAdjustment) => void,
): {
  articles: EasyPosInvoiceDraft['articles'];
  invoiceRebate?: Rebate;
} {
  if (!Number.isFinite(targetTotal) || targetTotal < 0) {
    return { articles, invoiceRebate };
  }
  // An invoice-level rebate has no VAT band. On a mixed ticket that files
  // the whole discount against one rate, so move it onto the lines first.
  if (positiveBands(articles).length > 1 && invoiceRebate) {
    const lines = invoiceTotalOf(articles);
    const fromValue = roundMoney(Number(invoiceRebate?.inValue || 0));
    const fromPercent =
      invoiceRebate?.inPercentage != null
        ? roundMoney(lines * ((Number(invoiceRebate.inPercentage) || 0) / 100))
        : 0;
    const rebateValue = roundMoney(fromValue + fromPercent);
    if (rebateValue >= 0.01) {
      articles = addLineRebates(articles, rebateValue);
    }
    invoiceRebate = undefined;
  }
  const current = invoiceTotalOf(articles, invoiceRebate);
  const diff = roundMoney(current - targetTotal);
  if (Math.abs(diff) < 0.01) return { articles, invoiceRebate };

  const bands = positiveBands(articles);
  const codes = bands.map((band) => band.code);
  const sole = codes.length === 1 ? codes[0] : undefined;
  onAdjustment?.({
    articleTotal: current,
    targetTotal,
    difference: diff,
    vatCode: bandLabel(codes) || defaultVatCode(settings),
  });

  // Charged less than the lines. One band can stay an invoice rebate — that
  // is the whole tax base. Mixed bands take the discount on each line.
  if (diff > 0) {
    if (sole) {
      return {
        articles,
        invoiceRebate: {
          inValue: roundMoney(Number(invoiceRebate?.inValue || 0) + diff),
        },
      };
    }
    const rebateNow = roundMoney(Number(invoiceRebate?.inValue || 0));
    return {
      articles: addLineRebates(articles, roundMoney(rebateNow + diff)),
    };
  }

  const shortfall = roundMoney(Math.abs(diff));
  const soldIn = fiscalArticleSettings(settings).soldIn;
  const shares =
    bands.length > 0
      ? allocateMoney(
          shortfall,
          bands.map((band) => band.weight),
        ).map((amount, index) => ({ code: bands[index].code, amount }))
      : [{ code: defaultVatCode(settings), amount: shortfall }];
  return {
    articles: [
      ...articles,
      ...shares
        .filter((share) => share.amount >= 0.01)
        .map((share) => ({
          articleId: resolveArticleId('POS-ADJUSTMENT', 'Adjustment', settings),
          vatCode: share.code,
          name: 'Adjustment',
          soldIn,
          price: share.amount,
          units: 1,
        })),
    ],
    invoiceRebate,
  };
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
 * catalog SKU to send: POS-generated lines (service charge, balancing
 * adjustment) and items that were never given a SKU.
 */
function resolveArticleId(
  sku: string,
  name: string,
  settings: SettingsDTO,
): string {
  const { cloud, cloudFallbackArticleId } = fiscalArticleSettings(settings);
  const fromSku = String(sku || '').trim();
  const isCatalogSku = fromSku.length > 0 && !fromSku.startsWith('POS-');
  if (isCatalogSku) return fromSku.slice(0, 100);
  if (cloud && cloudFallbackArticleId)
    return cloudFallbackArticleId.slice(0, 100);
  if (fromSku) return fromSku.slice(0, 100);
  return `ITEM-${String(name || 'item').slice(0, 24)}`.slice(0, 100);
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
      name: String(it.name || 'Item').slice(0, 100),
      // Weighed items are sold in kilograms (UN/CEFACT KGM); filing 0.35
      // "pieces" misstates the unit on the invoice.
      soldIn: (it as any).soldByKg === true ? SOLD_BY_KG_UNIT : soldIn,
      price: Number(it.unitPrice || 0),
      units: qty,
    });
  }

  const scAmt = Number(meta.serviceChargeAmount || 0);
  if (Number.isFinite(scAmt) && scAmt > 0) {
    const bands = positiveBands(articles);
    const shares =
      bands.length > 0
        ? allocateMoney(
            scAmt,
            bands.map((band) => band.weight),
          ).map((amount, index) => ({ code: bands[index].code, amount }))
        : [{ code: defaultVatCode(settings), amount: roundMoney(scAmt) }];
    for (const share of shares) {
      if (share.amount < 0.01) continue;
      articles.push({
        articleId: resolveArticleId(
          'POS-SERVICE-CHARGE',
          'Service charge',
          settings,
        ),
        vatCode: share.code,
        name: 'Service charge',
        soldIn,
        price: share.amount,
        units: 1,
      });
    }
  }

  return articles;
}

function buildPaymentArray(
  articles: EasyPosInvoiceDraft['articles'],
  invoiceRebate: Rebate | undefined,
  payload: TicketPrintPayload,
): Array<{ type: string; amount: number }> {
  const meta: any = payload.meta || {};
  const method = mapPaymentMethod(
    String(meta.method || meta.paymentMethod || 'CASH'),
  );
  const fromLines =
    articles.length > 0 ? invoiceTotalOf(articles, invoiceRebate) : undefined;
  const totalAfter = Number(meta.totalAfter);
  const total = Number(meta.total);
  const amountPaid = Number(meta.amountPaid);

  // easyPos requires payment total === invoice total after rebates.
  // `amountPaid` is cash tendered (with change), not the invoice total.
  let amount = 0;
  if (fromLines != null && Number.isFinite(fromLines)) {
    amount = fromLines;
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

/**
 * The lines of a restated sale — a corrective invoice, or a queued invoice
 * replaced after an admin struck some of its lines.
 *
 * Built exactly like the original invoice (same article IDs, service charge
 * line, discount rebate) and reconciled to the amount the sale now totals,
 * because easyPos rejects any document whose lines and payment differ. The
 * restated total keeps the original service charge and discount — striking
 * a line takes only that line's gross off — so they are carried over whole,
 * the discount capped at what is left to discount.
 */
export function buildRestatedInvoiceLines(
  input: {
    items: Array<{
      sku?: string;
      name: string;
      qty: number;
      unitPrice: number;
      vatRate: number;
    }>;
    serviceChargeAmount?: number | null;
    discountAmount?: number | null;
    total: number;
  },
  settings: SettingsDTO,
  options?: { onAdjustment?: (info: DraftAdjustment) => void },
): {
  articles: EasyPosInvoiceDraft['articles'];
  invoiceRebate?: Rebate;
  amount: number;
} {
  const positive = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? roundMoney(n) : 0;
  };
  const serviceChargeAmount = positive(input.serviceChargeAmount);
  const payload = {
    items: input.items,
    meta: { serviceChargeAmount },
  } as unknown as TicketPrintPayload;
  let articles = buildArticles(payload, settings);
  if (articles.length === 0) {
    throw new Error('Cannot fiscalize an empty ticket.');
  }
  const gross = invoiceTotalOf(articles);
  const discount = Math.min(positive(input.discountAmount), gross);
  let invoiceRebate: Rebate | undefined =
    discount > 0 ? { inValue: discount } : undefined;
  const reconciled = reconcileToChargedTotal(
    articles,
    invoiceRebate,
    roundMoney(Math.max(0, Number(input.total) || 0)),
    settings,
    options?.onAdjustment,
  );
  articles = reconciled.articles;
  invoiceRebate = reconciled.invoiceRebate;
  return {
    articles,
    ...(invoiceRebate ? { invoiceRebate } : {}),
    amount: invoiceTotalOf(articles, invoiceRebate),
  };
}

/**
 * The lines of a corrective invoice for a partial void: each struck line
 * as filed originally (same article id, VAT band, unit), with its units
 * negated. Returns the (negative) total the payment must carry.
 */
export function buildCorrectionDifferenceLines(
  items: Array<{
    sku?: string;
    name: string;
    qty: number;
    unitPrice: number;
    vatRate: number;
    soldByKg?: boolean;
  }>,
  settings: SettingsDTO,
): { articles: EasyPosInvoiceDraft['articles']; amount: number } {
  const payload = { items, meta: {} } as unknown as TicketPrintPayload;
  const articles = buildArticles(payload, settings).map((a) => ({
    ...a,
    units: -a.units,
  }));
  if (articles.length === 0) {
    throw new Error('A corrective invoice needs at least one struck line.');
  }
  return { articles, amount: invoiceTotalOf(articles) };
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
  let invoiceRebate = ticketDiscountRebate(payload);
  const totalAfter = Number((payload.meta as any)?.totalAfter);
  if (Number.isFinite(totalAfter) && totalAfter >= 0) {
    const reconciled = reconcileToChargedTotal(
      articles,
      invoiceRebate,
      totalAfter,
      settings,
      options?.onAdjustment,
    );
    articles = reconciled.articles;
    invoiceRebate = reconciled.invoiceRebate;
  }
  const draft: EasyPosCloudInvoiceDraft = {
    docId: ensureDocId(options),
    articles,
    payment: buildPaymentArray(articles, invoiceRebate, payload),
  };
  if (invoiceRebate) draft.invoiceRebate = invoiceRebate;
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

  let articles = buildArticles(payload, settings);
  if (articles.length === 0) {
    throw new Error('Cannot fiscalize an empty ticket.');
  }
  let invoiceRebate = ticketDiscountRebate(payload);

  const meta: any = payload.meta || {};
  const method = mapPaymentMethod(
    String(meta.method || meta.paymentMethod || 'CASH'),
  );
  const totalAfter = Number(meta.totalAfter);
  const total = Number(meta.total);
  const articleTotal = invoiceTotalOf(articles, invoiceRebate);
  const amountDue =
    Number.isFinite(totalAfter) && totalAfter >= 0
      ? totalAfter
      : Number.isFinite(total) && total > 0
        ? total
        : articleTotal;
  if (Number.isFinite(amountDue) && amountDue >= 0) {
    const reconciled = reconcileToChargedTotal(
      articles,
      invoiceRebate,
      amountDue,
      settings,
      options?.onAdjustment,
    );
    articles = reconciled.articles;
    invoiceRebate = reconciled.invoiceRebate;
  }
  const payment =
    Number.isFinite(amountDue) && amountDue > 0
      ? { type: method, amount: roundMoney(amountDue) }
      : { type: method };

  const draft: EasyPosInvoiceDraft = {
    app: 'OneTap POS',
    articles,
    payment,
  };
  if (invoiceRebate) draft.invoiceRebate = invoiceRebate;

  const docId = String(options?.docId || '').trim();
  if (docId) draft.docId = docId;

  return draft;
}
