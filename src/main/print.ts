import type { SettingsDTO, TicketPrintMeta } from '@shared/ipc';
import { resolveVatEnabledFromMeta } from '@shared/vatFromFiscal';
import { effectiveVatRate, splitGrossVat } from '@shared/ticketRevenue';
import {
  editionHasTables,
  formatSaleLocation,
  isStoreCounterArea,
} from '@shared/editionCapabilities';
import {
  printCopyFromSettings,
  printLangFromSettings,
  printPaymentMethod,
  printStaffLabel,
} from '@shared/printCopy';
import {
  fiscalTinFromSettings,
  fiscalVerificationQr,
  isFiscalPending,
  isFiscalRegistered,
} from '@shared/fiscalReceipt';
import { dualTotalsFromSettings } from '@shared/paymentDisplay';
import { getActiveLicenseEdition } from './services/license';
import os from 'node:os';
import { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withTimeout } from './services/withTimeout';
import {
  ESC_POS_FONT_A,
  ESC_POS_PC850,
  encodeEscposText,
  escposQrCode,
  formatTwoCol,
  layoutFromSettings,
  wrapEscposText,
  type ReceiptLayout,
} from './escposEncode';

// ESC/POS helpers
const ESC = Buffer.from([0x1b]);
const GS = Buffer.from([0x1d]);

/**
 * Pulse the cash drawer connected to the receipt printer (ESC p).
 * Pin 2 (m=0) is the Epson-compatible default used by most RJ-11 tills.
 * ON ≈ 50ms, OFF ≈ 500ms.
 */
export function cmdOpenCashDrawer(pin: 0 | 1 = 0): Buffer {
  return Buffer.from([0x1b, 0x70, pin, 0x19, 0xfa]);
}

function cmdPrinterInit(): Buffer[] {
  return [ESC, Buffer.from('@'), ESC_POS_FONT_A, ESC_POS_PC850];
}

function receiptDiningFloor(area?: string | null): boolean {
  if (isStoreCounterArea(area)) return false;
  return editionHasTables(getActiveLicenseEdition());
}

function receiptStaffLabel(
  diningFloor: boolean,
  lang: ReturnType<typeof printLangFromSettings>,
): string {
  return printStaffLabel(lang, diningFloor);
}

function kitchenOrderIdentity(payload: TicketPrintPayload): string {
  const loc = formatSaleLocation({
    diningFloor: receiptDiningFloor(payload.area),
    area: payload.area,
    tableLabel: payload.tableLabel,
    emptyLabel: '',
  });
  const name = String(payload.userName || '').trim();
  return [name, loc].filter(Boolean).join(' - ');
}

function kitchenOrderIdentityLines(
  payload: TicketPrintPayload,
  width: number,
): string[] {
  const loc = formatSaleLocation({
    diningFloor: receiptDiningFloor(payload.area),
    area: payload.area,
    tableLabel: payload.tableLabel,
    emptyLabel: '',
  });
  const name = String(payload.userName || '').trim();
  const one = [name, loc].filter(Boolean).join(' - ');
  if (!one) return [];
  if (one.length <= width) return [one];
  if (name && loc) return [name, loc];
  return wrapEscposText(one, width);
}

function kitchenItemLayout(layout: ReceiptLayout): ReceiptLayout {
  const cols = layout.doubleWidthCols;
  const priceCols = 3;
  return {
    ...layout,
    cols,
    priceCols,
    nameCols: Math.max(8, cols - priceCols),
    sep: '-'.repeat(cols),
  };
}

function twoCol(left: string, right: string, layout: ReceiptLayout): Buffer[] {
  return formatTwoCol(left, right, layout)
    .split('\n')
    .map((ln) => escposText(`${ln}\n`));
}

export type TicketPrintItem = {
  name: string;
  qty: number;
  unitPrice: number;
  vatRate?: number;
  note?: string;
  sku?: string;
  station?: 'KITCHEN' | 'BAR' | 'DESSERT';
  categoryId?: number;
  categoryName?: string;
  courseId?: string | null;
};

function aggregateTicketItems(items: TicketPrintItem[]): TicketPrintItem[] {
  const arr = Array.isArray(items) ? items : [];
  // Group only when items are "the same" for printing purposes.
  // We include note in the key so items with different notes stay separate.
  const keyOf = (it: TicketPrintItem) => {
    const sku = String(it.sku || '').trim();
    const name = String(it.name || '').trim();
    const unitPrice = Number(it.unitPrice || 0);
    const vatRate = Number(it.vatRate || 0);
    const note = String(it.note || '').trim();
    return `${sku || name}||${unitPrice.toFixed(4)}||${vatRate.toFixed(6)}||${note}`;
  };
  const map = new Map<string, TicketPrintItem>();
  const order: string[] = [];
  for (const it of arr) {
    const qty = Number(it?.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const key = keyOf(it);
    const existing = map.get(key);
    if (!existing) {
      order.push(key);
      map.set(key, { ...it, qty });
    } else {
      existing.qty = Number(existing.qty || 0) + qty;
    }
  }
  return order.map((k) => map.get(k)!).filter(Boolean);
}

/** Guest payment / bill slips — kitchen ORDER tickets keep notes. */
export function isCustomerFacingPrintKind(kind: string): boolean {
  const k = String(kind || '').toUpperCase();
  return k === 'PAYMENT' || k === 'RECEIPT';
}

/** Drop ticket + line notes so customer receipts stay clean. */
export function withoutKitchenNotes(
  payload: TicketPrintPayload,
): TicketPrintPayload {
  return {
    ...payload,
    note: null,
    items: (Array.isArray(payload.items) ? payload.items : []).map((it) => ({
      ...it,
      note: undefined,
    })),
  };
}
export type TicketPrintPayload = {
  area: string;
  tableLabel: string;
  covers?: number | null;
  items: TicketPrintItem[];
  note?: string | null;
  printedAtIso?: string; // optional, defaults to now
  userName?: string; // optional waiter name
  meta?: TicketPrintMeta;
};

export type ShiftClosePrintSummary = {
  waiterName: string;
  openedAtIso: string;
  closedAtIso: string;
  orders: number;
  revenueNet: number;
  revenueVat: number;
  revenueGross: number;
  vatEnabled: boolean;
  byMethod: { method: string; amount: number }[];
};

export function buildEscposShiftSummary(
  summary: ShiftClosePrintSummary,
  settings: SettingsDTO,
): Buffer {
  const lang = printLangFromSettings(settings);
  const copy = printCopyFromSettings(settings);
  const restaurant = settings.restaurantName || copy.restaurantFallback;
  const currency = settings.currency || 'EUR';
  const layout = layoutFromSettings(settings);
  const opened = formatDateTime(new Date(summary.openedAtIso));
  const closed = formatDateTime(new Date(summary.closedAtIso));

  const lines: Buffer[] = [];
  lines.push(...cmdPrinterInit());
  lines.push(cmdAlign('center'));
  lines.push(cmdBold(true));
  lines.push(cmdTextSize('lg'));
  for (const ln of wrapEscposText(restaurant, layout.doubleWidthCols)) {
    lines.push(escposText(`${ln}\n`));
  }
  lines.push(cmdTextSize('normal'));
  lines.push(escposText(`${copy.shiftReport}\n`));
  lines.push(cmdBold(false));
  lines.push(escposText(`${layout.sep}\n`));
  lines.push(cmdAlign('left'));
  lines.push(
    escposText(
      `${receiptStaffLabel(editionHasTables(getActiveLicenseEdition()), lang)}: ${summary.waiterName}\n`,
    ),
  );
  lines.push(escposText(`${copy.opened}: ${opened}\n`));
  lines.push(escposText(`${copy.closed}: ${closed}\n`));
  lines.push(escposText(`${layout.sep}\n`));
  lines.push(...twoCol(copy.orders, String(summary.orders), layout));
  lines.push(
    ...twoCol(copy.netSales, formatMoneyEscpos(summary.revenueNet), layout),
  );
  if (summary.vatEnabled) {
    lines.push(
      ...twoCol(copy.vat, formatMoneyEscpos(summary.revenueVat), layout),
    );
  }
  lines.push(cmdBold(true));
  lines.push(
    ...twoCol(copy.total, formatMoneyEscpos(summary.revenueGross), layout),
  );
  lines.push(cmdBold(false));
  lines.push(
    ...twoCol(
      copy.currency,
      String(currency).slice(0, 3).toUpperCase(),
      layout,
    ),
  );
  if (summary.byMethod.length > 0) {
    lines.push(escposText(`${layout.sep}\n`));
    lines.push(escposText(`${copy.byPayment}\n`));
    for (const row of summary.byMethod) {
      lines.push(
        ...twoCol(
          printPaymentMethod(lang, row.method),
          formatMoneyEscpos(row.amount),
          layout,
        ),
      );
    }
  }
  lines.push(escposText('\n'));
  lines.push(cmdAlign('center'));
  lines.push(escposText(`${copy.endOfShift}\n`));
  lines.push(cmdAlign('left'));
  lines.push(escposText('\n'));
  lines.push(GS, Buffer.from('V'), Buffer.from([0x41]), Buffer.from([0x10]));
  return Buffer.concat(lines);
}

export function buildEscposTicket(
  rawPayload: TicketPrintPayload,
  settings: SettingsDTO,
): Buffer {
  const metaEarly: any = rawPayload.meta || {};
  const kindEarly = String(metaEarly?.kind || '').toUpperCase();
  if (kindEarly === 'SHIFT_CLOSE' && metaEarly?.shiftSummary) {
    return buildEscposShiftSummary(
      metaEarly.shiftSummary as ShiftClosePrintSummary,
      settings,
    );
  }

  const payload = isCustomerFacingPrintKind(kindEarly)
    ? withoutKitchenNotes(rawPayload)
    : rawPayload;
  const meta: any = payload.meta || {};

  const now = payload.printedAtIso
    ? new Date(payload.printedAtIso)
    : new Date();
  const nowStr = formatDateTime(now);
  const lang = printLangFromSettings(settings);
  const copy = printCopyFromSettings(settings);
  const restaurant = settings.restaurantName || copy.restaurantFallback;
  const businessInfo: any = (settings as any).businessInfo || {};
  const bizAddress = String(businessInfo?.address || '').trim();
  const bizPhone = String(businessInfo?.phone || '').trim();
  const bizEmail = String(businessInfo?.email || '').trim();
  const bizWebsite = String(businessInfo?.website || '').trim();
  const currency = settings.currency || 'EUR';
  const layout = layoutFromSettings(settings);

  const lines: Buffer[] = [];
  lines.push(...cmdPrinterInit());

  const kind = String(meta?.kind || '').toUpperCase();
  const paymentMethodRaw = String(
    meta?.method || meta?.paymentMethod || '',
  ).toUpperCase();
  const hidePrices = Boolean(meta?.hidePrices) || kind === 'ORDER';
  // Guest bills/receipts need readable body text; kitchen ORDER stays as-is.
  const customerReceipt = kind !== 'ORDER';
  const bodySize = customerReceipt ? 'md' : 'normal';
  const itemsToPrint: TicketPrintItem[] = hidePrices
    ? payload.items || []
    : aggregateTicketItems(payload.items || []);

  // Header (restaurant-style). Kitchen ORDER slips skip the brand block —
  // waiter/table, items, then time is all the pass needs.
  if (kind !== 'ORDER') {
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(true));
    lines.push(cmdTextSize('lg'));
    for (const ln of wrapEscposText(restaurant, layout.doubleWidthCols)) {
      lines.push(escposText(`${ln}\n`));
    }
    lines.push(cmdTextSize(bodySize));
    lines.push(cmdBold(false));
    // Subtitle: address + phone (business info)
    const subtitleLines: string[] = [];
    if (bizAddress) {
      for (const raw of String(bizAddress).split(/\r?\n/g)) {
        const t = String(raw || '').trim();
        if (!t) continue;
        subtitleLines.push(...wrapEscposText(t, layout.cols));
      }
    }
    if (bizPhone) subtitleLines.push(...wrapEscposText(bizPhone, layout.cols));
    for (const ln of subtitleLines) lines.push(escposText(`${ln}\n`));
    lines.push(escposText(`${layout.sep}\n`));
  }
  lines.push(cmdAlign('left'));
  // Avoid Unicode bullets / fancy separators (often render as garbage on ESC/POS)
  const diningFloor = receiptDiningFloor(payload.area);
  const tableInfo = formatSaleLocation({
    diningFloor,
    area: payload.area,
    tableLabel: payload.tableLabel,
    emptyLabel: copy.sale,
  });
  if (kind !== 'ORDER') {
    lines.push(escposText(`${tableInfo}\n`));
    if (diningFloor && payload.covers)
      lines.push(escposText(`${copy.covers}: ${payload.covers}\n`));
    const seatLabel = String(meta?.seatLabel || '').trim();
    if (seatLabel) {
      lines.push(cmdBold(true));
      lines.push(escposText(`${seatLabel.toUpperCase()}\n`));
      lines.push(cmdBold(false));
    }
    if (payload.userName)
      lines.push(
        escposText(
          `${receiptStaffLabel(diningFloor, lang)}: ${payload.userName}\n`,
        ),
      );
    lines.push(escposText(`${nowStr}\n`));
    lines.push(escposText(`${layout.sep}\n`));
  } else {
    const routeLabel = String(meta?.routeLabel || '').trim();
    if (routeLabel) {
      lines.push(cmdBold(true));
      lines.push(cmdTextSize('lg'));
      for (const ln of wrapEscposText(routeLabel, layout.doubleWidthCols)) {
        lines.push(escposText(`${ln}\n`));
      }
      lines.push(cmdTextSize('normal'));
      lines.push(cmdBold(false));
    }
    const identityLines = kitchenOrderIdentityLines(
      payload,
      layout.doubleWidthCols,
    );
    if (identityLines.length) {
      lines.push(cmdBold(true));
      lines.push(cmdTextSize('lg'));
      for (const ln of identityLines) {
        lines.push(escposText(`${ln}\n`));
      }
      lines.push(cmdTextSize('normal'));
      lines.push(cmdBold(false));
    }
    lines.push(escposText(`${layout.sep}\n`));
  }

  // Items. Prices are VAT-inclusive (Albanian fiscalization): the gross
  // line already contains the tax, so VAT is extracted, never added on top.
  let grossSubtotal = 0;
  let vat = 0;
  const vatEnabled = resolveVatEnabledFromMeta(meta, settings);
  const defaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  if (kind === 'ORDER') {
    lines.push(cmdTextSize('lg'));
    lines.push(cmdBold(true));
  }
  const orderLayout = kitchenItemLayout(layout);
  for (const it of itemsToPrint) {
    const qty = Number(it.qty || 1);
    const linePrice = Number(it.unitPrice || 0) * qty;
    grossSubtotal += linePrice;
    if (vatEnabled) {
      const rate = effectiveVatRate(it.vatRate, defaultVatRate);
      vat += splitGrossVat(linePrice, rate).vat;
    }
    if (kind === 'ORDER') {
      lines.push(...twoCol(String(it.name || ''), String(qty), orderLayout));
      if (it.note) {
        lines.push(cmdBold(false));
        lines.push(cmdTextSize('normal'));
        for (const ln of wrapEscposText(
          `  - ${String(it.note)}`,
          layout.cols,
        )) {
          lines.push(escposText(`${ln}\n`));
        }
        lines.push(cmdTextSize('lg'));
        lines.push(cmdBold(true));
      }
    } else {
      const left = `${qty} x ${String(it.name || '')}`;
      const right = hidePrices ? '' : formatMoneyEscpos(linePrice);
      lines.push(...twoCol(left, right, layout));
      if (it.note) {
        for (const ln of wrapEscposText(
          `  - ${String(it.note)}`,
          layout.cols,
        )) {
          lines.push(escposText(`${ln}\n`));
        }
      }
    }
  }

  // Totals (skip for ORDER slips). Net is the gross minus the contained
  // VAT so that Subtotal + VAT == gross total (the menu-price sum).
  const subtotal = grossSubtotal - vat;
  const scAmt = Number(meta?.serviceChargeAmount || 0);
  const discountAmt = Number(meta?.discountAmount || 0);
  const baseTotal = subtotal + vat;
  const totalAfter = Number(meta?.totalAfter);
  const fallbackTotal = Math.max(
    0,
    baseTotal +
      (Number.isFinite(scAmt) ? scAmt : 0) -
      (Number.isFinite(discountAmt) ? discountAmt : 0),
  );
  const totalFinal = Number.isFinite(totalAfter)
    ? Math.max(0, totalAfter)
    : fallbackTotal;
  if (!hidePrices) {
    lines.push(escposText(`${layout.sep}\n`));
    lines.push(...twoCol(copy.subtotal, formatMoneyEscpos(subtotal), layout));
    if (vatEnabled)
      lines.push(...twoCol(copy.vat, formatMoneyEscpos(vat), layout));
    if (Number.isFinite(scAmt) && scAmt > 0) {
      const mode = String(meta?.serviceChargeMode || '').toUpperCase();
      const v = meta?.serviceChargeValue;
      const label =
        mode === 'PERCENT' && Number.isFinite(Number(v))
          ? copy.servicePct(Number(v))
          : copy.service;
      lines.push(...twoCol(label, formatMoneyEscpos(scAmt), layout));
    }
    if (Number.isFinite(discountAmt) && discountAmt > 0) {
      const dtype = String(meta?.discountType || '').toUpperCase();
      const dval = meta?.discountValue;
      const label =
        dtype === 'PERCENT' && Number.isFinite(Number(dval))
          ? copy.discountPct(Number(dval))
          : copy.discount;
      lines.push(
        ...twoCol(label, '-' + formatMoneyEscpos(discountAmt), layout),
      );
    }
    lines.push(cmdBold(true));
    lines.push(cmdTextSize(customerReceipt ? 'lg' : 'md'));
    lines.push(...twoCol(copy.total, formatMoneyEscpos(totalFinal), layout));
    lines.push(cmdTextSize(bodySize));
    lines.push(cmdBold(false));
    // Guest receipts (paid or unpaid bill) show LEK + EUR when Kursi EUR
    // is set — fiscalization is unrelated.
    if (kind === 'PAYMENT' || kind === 'RECEIPT') {
      const fx = dualTotalsFromSettings(totalFinal, settings);
      if (fx.lek != null) {
        lines.push(...twoCol(copy.totalLek, formatMoneyEscpos(fx.lek), layout));
      }
      if (fx.eur != null) {
        lines.push(...twoCol(copy.totalEur, formatMoneyEscpos(fx.eur), layout));
      }
    } else {
      lines.push(
        ...twoCol(
          copy.currency,
          String(currency).slice(0, 3).toUpperCase(),
          layout,
        ),
      );
    }
  }

  // Payment section (only for payment receipts)
  if (kind === 'PAYMENT') {
    const method = printPaymentMethod(
      lang,
      String(meta?.method || meta?.paymentMethod || ''),
    );
    const approvedBy = String(meta?.managerApprovedByName || '').trim();
    lines.push(escposText(`${layout.sep}\n`));
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(true));
    lines.push(escposText(`${copy.paid}\n`));
    lines.push(cmdBold(false));
    lines.push(cmdAlign('left'));
    if (method) lines.push(escposText(`${copy.method}: ${method}\n`));
    if (approvedBy) lines.push(escposText(`${copy.approved}: ${approvedBy}\n`));

    const fiscalNivf = String(meta?.fiscalNivf || '').trim();
    const fiscalNslf = String(meta?.fiscalNslf || '').trim();
    const fiscalLink = String(meta?.fiscalLink || '').trim();
    const fiscalQrCode = String((meta as any)?.fiscalQrCode || '').trim();
    if (meta?.fiscalEnabled && isFiscalPending(meta as any)) {
      lines.push(escposText(`${layout.sep}\n`));
      lines.push(cmdAlign('center'));
      lines.push(cmdBold(true));
      lines.push(escposText(`${copy.fiscalPendingTitle}\n`));
      lines.push(cmdBold(false));
      for (const ln of wrapEscposText(copy.fiscalPendingBody, layout.cols)) {
        lines.push(escposText(`${ln}\n`));
      }
      lines.push(cmdAlign('left'));
    } else if (meta?.fiscalEnabled && isFiscalRegistered(meta as any)) {
      const fiscalLineWidth = layout.cols;
      const qr = fiscalVerificationQr({
        link: fiscalLink,
        qrCode: fiscalQrCode,
        nslf: fiscalNslf,
        tin:
          String((meta as any)?.fiscalTin || '').trim() ||
          fiscalTinFromSettings(settings),
        issuedAt: meta?.paidAt,
        total: totalFinal,
      });
      lines.push(escposText(`${layout.sep}\n`));
      lines.push(cmdAlign('center'));
      lines.push(cmdBold(true));
      lines.push(escposText(`${copy.fiscalRegistered}\n`));
      lines.push(cmdBold(false));
      if (fiscalNivf) {
        for (const ln of wrapEscposText(
          `NIVF: ${fiscalNivf}`,
          fiscalLineWidth,
        )) {
          lines.push(escposText(`${ln}\n`));
        }
      }
      if (fiscalNslf) {
        for (const ln of wrapEscposText(
          `NSLF: ${fiscalNslf}`,
          fiscalLineWidth,
        )) {
          lines.push(escposText(`${ln}\n`));
        }
      }
      if (qr) {
        lines.push(escposText('\n\n'));
        lines.push(cmdAlign('center'));
        lines.push(escposQrCode(qr, { paperMm: layout.paperMm }));
        lines.push(escposText('\n\n'));
      }
      lines.push(cmdAlign('left'));
    }
  }

  if (payload.note) {
    if (kind === 'ORDER') {
      lines.push(cmdBold(false));
      lines.push(cmdTextSize('normal'));
    }
    lines.push(escposText(`\n${copy.note}:\n`));
    for (const ln of wrapEscposText(String(payload.note), layout.cols)) {
      lines.push(escposText(`${ln}\n`));
    }
  }

  if (kind === 'ORDER') {
    lines.push(cmdBold(false));
    lines.push(cmdTextSize('normal'));
    lines.push(escposText(`${layout.sep}\n`));
    lines.push(escposText(`${nowStr}\n`));
  }

  // Footer and cut (customer receipts only — kitchen ORDER slips stay minimal)
  lines.push(escposText('\n'));
  if (kind !== 'ORDER') {
    lines.push(cmdAlign('center'));
    lines.push(escposText(`${copy.thankYou}\n`));
    // Business contact (below thank-you)
    if (bizEmail) lines.push(escposText(`${bizEmail}\n`));
    if (bizWebsite) lines.push(escposText(`${bizWebsite}\n`));
    lines.push(escposText(`${copy.poweredBy}\n`));
    lines.push(cmdAlign('left'));
  }
  lines.push(escposText('\n'));
  // Cash payment receipts: kick the till drawer on the receipt printer
  // before cutting so NETWORK / SERIAL / CUPS-raw paths all open it.
  // Use the raw method (CASH), not the localized label (e.g. PARA).
  if (kind === 'PAYMENT' && paymentMethodRaw === 'CASH') {
    lines.push(cmdOpenCashDrawer(0));
  }
  lines.push(GS, Buffer.from('V'), Buffer.from([0x41]), Buffer.from([0x10])); // partial cut

  return Buffer.concat(lines);
}

export function buildHtmlReceipt(
  rawPayload: TicketPrintPayload,
  settings: SettingsDTO,
): string {
  const metaEarly: any = rawPayload.meta || {};
  const kindEarly = String(metaEarly?.kind || '').toUpperCase();
  const payload = isCustomerFacingPrintKind(kindEarly)
    ? withoutKitchenNotes(rawPayload)
    : rawPayload;

  const now = payload.printedAtIso
    ? new Date(payload.printedAtIso)
    : new Date();
  const nowStr = formatDateTime(now);
  const lang = printLangFromSettings(settings);
  const copy = printCopyFromSettings(settings);
  const restaurant = settings.restaurantName || copy.restaurantFallback;
  const businessInfo: any = (settings as any).businessInfo || {};
  const bizAddress = String(businessInfo?.address || '').trim();
  const bizPhone = String(businessInfo?.phone || '').trim();
  const bizEmail = String(businessInfo?.email || '').trim();
  const bizWebsite = String(businessInfo?.website || '').trim();
  const currency = settings.currency || 'EUR';
  const paperMm = layoutFromSettings(settings).paperMm;
  const meta: any = payload.meta || {};
  const vatEnabled = resolveVatEnabledFromMeta(meta, settings);
  const defaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  const kind = String(meta?.kind || '').toUpperCase();
  const hidePrices = Boolean(meta?.hidePrices) || kind === 'ORDER';
  const seatLabel = String(meta?.seatLabel || '').trim();
  const routeLabel = String(meta?.routeLabel || '').trim();
  const orderIdentity = kind === 'ORDER' ? kitchenOrderIdentity(payload) : '';

  const safe = (s: any) =>
    String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const itemsRaw = Array.isArray(payload.items) ? payload.items : [];
  const items = hidePrices ? itemsRaw : aggregateTicketItems(itemsRaw);
  // VAT-inclusive: the gross line already contains the tax, so we extract
  // the contained VAT rather than adding it on top of the menu price.
  const grossSubtotal = items.reduce(
    (sum, it) => sum + Number(it.unitPrice || 0) * Number(it.qty || 1),
    0,
  );
  const vat = vatEnabled
    ? items.reduce((sum, it) => {
        const lineGross = Number(it.unitPrice || 0) * Number(it.qty || 1);
        const rate = effectiveVatRate(it.vatRate, defaultVatRate);
        return sum + splitGrossVat(lineGross, rate).vat;
      }, 0)
    : 0;
  const subtotal = grossSubtotal - vat;
  const scAmt = Number(meta?.serviceChargeAmount || 0);
  const discountAmt = Number(meta?.discountAmount || 0);
  const baseTotal = subtotal + vat;
  const totalAfter = Number(meta?.totalAfter);
  const fallbackTotal = Math.max(
    0,
    baseTotal +
      (Number.isFinite(scAmt) ? scAmt : 0) -
      (Number.isFinite(discountAmt) ? discountAmt : 0),
  );
  const totalFinal = Number.isFinite(totalAfter)
    ? Math.max(0, totalAfter)
    : fallbackTotal;
  const fx =
    kind === 'PAYMENT' || kind === 'RECEIPT'
      ? dualTotalsFromSettings(totalFinal, settings)
      : { lek: null, eur: null };

  const rows = items
    .map((it) => {
      const qty = Number(it.qty || 1);
      const line = Number(it.unitPrice || 0) * qty;
      const note = it.note ? `<div class="note">- ${safe(it.note)}</div>` : '';
      const right =
        kind === 'ORDER'
          ? safe(String(qty))
          : hidePrices
            ? ''
            : safe(formatMoney(line, currency));
      const left =
        kind === 'ORDER' ? safe(it.name) : safe(`${qty} x ${it.name}`);
      const rowClass = kind === 'ORDER' ? 'row orderItem' : 'row';
      return `<div class="${rowClass}"><div class="left">${left}</div><div class="right">${right}</div></div>${note}`;
    })
    .join('\n');

  const scLine =
    Number.isFinite(scAmt) && scAmt > 0
      ? `<div class="row"><div class="left">${safe(String(meta?.serviceChargeMode || '').toUpperCase() === 'PERCENT' ? copy.servicePct(Number(meta?.serviceChargeValue || 0)) : copy.service)}</div><div class="right">${safe(formatMoney(scAmt, currency))}</div></div>`
      : '';
  const discountLine =
    Number.isFinite(discountAmt) && discountAmt > 0
      ? `<div class="row"><div class="left">${safe(String(meta?.discountType || '').toUpperCase() === 'PERCENT' ? copy.discountPct(Number(meta?.discountValue || 0)) : copy.discount)}</div><div class="right">-${safe(formatMoney(discountAmt, currency))}</div></div>`
      : '';
  const fiscalNivf = String(meta?.fiscalNivf || '').trim();
  const fiscalNslf = String(meta?.fiscalNslf || '').trim();
  const fiscalLink = String(meta?.fiscalLink || '').trim();
  const fiscalQrCode = String((meta as any)?.fiscalQrCode || '').trim();
  const fiscalQr = fiscalVerificationQr({
    link: fiscalLink,
    qrCode: fiscalQrCode,
    nslf: fiscalNslf,
    tin:
      String((meta as any)?.fiscalTin || '').trim() ||
      fiscalTinFromSettings(settings),
    issuedAt: meta?.paidAt,
    total: totalFinal,
  });
  const fiscalBlock =
    kind === 'PAYMENT' && meta?.fiscalEnabled && isFiscalPending(meta as any)
      ? `<div class="sep"></div><div class="paid">${safe(copy.fiscalPendingTitle)}</div><div class="small">${safe(copy.fiscalPendingBody)}</div>`
      : kind === 'PAYMENT' &&
          meta?.fiscalEnabled &&
          isFiscalRegistered(meta as any)
        ? `<div class="sep"></div><div class="paid">${safe(copy.fiscalRegistered)}</div>${fiscalNivf ? `<div class="small">NIVF: ${safe(fiscalNivf)}</div>` : ''}${fiscalNslf ? `<div class="small">NSLF: ${safe(fiscalNslf)}</div>` : ''}${fiscalQr ? `<div class="small"><a href="${safe(fiscalQr)}">${safe(fiscalQr)}</a></div>` : ''}`
        : '';
  const payMethod = printPaymentMethod(
    lang,
    String(meta?.method || meta?.paymentMethod || ''),
  );
  const paidBlock =
    kind === 'PAYMENT'
      ? `<div class="sep"></div><div class="paid">${safe(copy.paid)}</div>${payMethod ? `<div class="small">${safe(copy.method)}: ${safe(payMethod)}</div>` : ''}${fiscalBlock}`
      : '';

  const subtitleParts: string[] = [];
  if (bizAddress) {
    const addrLines = String(bizAddress)
      .split(/\r?\n/g)
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    subtitleParts.push(...addrLines);
  }
  if (bizPhone) subtitleParts.push(bizPhone);
  const subtitleHtml =
    kind === 'ORDER' || subtitleParts.length === 0
      ? ''
      : `<div class="subtitle small">${subtitleParts.map((x) => safe(x)).join('<br/>')}</div>`;

  const contactHtmlParts: string[] = [];
  if (bizEmail) contactHtmlParts.push(safe(bizEmail));
  if (bizWebsite) contactHtmlParts.push(safe(bizWebsite));
  const contactHtml =
    contactHtmlParts.length === 0
      ? ''
      : `<div class="footer small">${contactHtmlParts.join('<br/>')}</div>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: ${paperMm}mm auto; margin: 2mm; }
      html, body { width: 100%; margin: 0; padding: 0; }
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; color: #000; font-size: 15px; }
      .title { text-align: center; font-weight: 800; font-size: 22px; margin: 2px 0 6px; }
      .titleSlip { text-align: center; font-weight: 500; font-size: 12px; margin: 2px 0 6px; }
      .subtitle { text-align: center; margin: -2px 0 6px; }
      .meta { margin: 2px 0; }
      .sep { border-top: 1px dashed #000; margin: 6px 0; }
      .small { font-size: 13px; }
      .row { display: flex; justify-content: space-between; gap: 8px; margin: 2px 0; }
      .left { flex: 1; word-break: break-word; }
      .right { min-width: 70px; text-align: right; white-space: nowrap; }
      .note { margin-left: 8px; font-size: 13px; }
      .orderItem { font-size: 22px; font-weight: 800; line-height: 1.2; margin: 3px 0; }
      .orderFoot { font-size: 22px; font-weight: 800; line-height: 1.2; margin: 4px 0 2px; }
      .orderIdentity { font-size: 28px; font-weight: 800; line-height: 1.15; margin: 4px 0 6px; }
      .total { font-weight: 800; font-size: 18px; }
      .paid { text-align: center; font-weight: 800; font-size: 16px; margin: 2px 0; }
      .footer { text-align: center; margin-top: 10px; }
    </style>
  </head>
  <body>
    ${
      kind === 'ORDER'
        ? `${routeLabel ? `<div class="orderFoot">${safe(routeLabel)}</div>` : ''}
    ${orderIdentity ? `<div class="orderIdentity">${safe(orderIdentity)}</div>` : ''}
    <div class="sep"></div>`
        : `<div class="title">${safe(restaurant)}</div>
    ${subtitleHtml}
    <div class="small">${safe(formatSaleLocation({ diningFloor: receiptDiningFloor(payload.area), area: payload.area, tableLabel: payload.tableLabel, emptyLabel: copy.sale }))}</div>
    ${receiptDiningFloor(payload.area) && payload.covers ? `<div class="small">${safe(copy.covers)}: ${safe(payload.covers)}</div>` : ''}
    ${seatLabel ? `<div class="paid">${safe(seatLabel.toUpperCase())}</div>` : ''}
    ${payload.userName ? `<div class="small">${safe(receiptStaffLabel(receiptDiningFloor(payload.area), lang))}: ${safe(payload.userName)}</div>` : ''}
    <div class="small">${safe(nowStr)}</div>
    <div class="sep"></div>`
    }
    ${rows}
    ${
      hidePrices
        ? ''
        : `<div class="sep"></div>
    <div class="row"><div class="left">${safe(copy.subtotal)}</div><div class="right">${safe(formatMoney(subtotal, currency))}</div></div>
    ${vatEnabled ? `<div class="row"><div class="left">${safe(copy.vat)}</div><div class="right">${safe(formatMoney(vat, currency))}</div></div>` : ''}
    ${scLine}
    ${discountLine}
    <div class="row total"><div class="left">${safe(copy.total)}</div><div class="right">${safe(formatMoney(totalFinal, currency))}</div></div>${
      fx.lek != null
        ? `<div class="row"><div class="left">${safe(copy.totalLek)}</div><div class="right">${safe(formatMoney(fx.lek, 'ALL'))}</div></div>`
        : ''
    }${
      fx.eur != null
        ? `<div class="row"><div class="left">${safe(copy.totalEur)}</div><div class="right">${safe(formatMoney(fx.eur, 'EUR'))}</div></div>`
        : ''
    }`
    }
    ${payload.note ? `<div class="sep"></div><div class="small">${safe(copy.note)}:</div><div class="small">${safe(payload.note)}</div>` : ''}
    ${paidBlock}
    ${
      kind === 'ORDER'
        ? `<div class="sep"></div>
    <div class="small">${safe(nowStr)}</div>`
        : `<div class="footer small">${safe(copy.thankYou)}</div>
    ${contactHtml}
    <div class="footer small">${safe(copy.poweredBy)}</div>`
    }
  </body>
</html>`;
}

/** Upper bound on rendering and handing a receipt to the OS print spooler. */
const SYSTEM_PRINT_TIMEOUT_MS = 20_000;

export async function printHtmlToSystemPrinter(opts: {
  html: string;
  deviceName?: string;
  silent?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const silent = opts.silent !== false;
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 800,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(opts.html)}`;
    await withTimeout(
      win.loadURL(url),
      SYSTEM_PRINT_TIMEOUT_MS,
      'Print render',
    );
    // A stalled driver can leave this callback unfired forever, which would
    // wedge the single print queue behind it. The window is destroyed in the
    // `finally` below, which abandons the job.
    const result = await withTimeout(
      new Promise<{ ok: boolean; error?: string }>((resolve) => {
        win.webContents.print(
          { silent, deviceName: opts.deviceName, printBackground: true },
          (success, reason) => {
            resolve(
              success
                ? { ok: true }
                : { ok: false, error: reason || 'Print failed' },
            );
          },
        );
      }),
      SYSTEM_PRINT_TIMEOUT_MS,
      'System print',
    );
    return result;
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Print failed') };
  } finally {
    try {
      win.destroy();
    } catch (e) {
      void e;
    }
  }
}

/** Upper bound on how long the CUPS `lp` helper may take to accept a job. */
const CUPS_TIMEOUT_MS = 15_000;

export async function sendToCupsRawPrinter(opts: {
  deviceName?: string;
  data: Buffer;
}): Promise<{ ok: boolean; error?: string }> {
  // macOS/Linux only. Windows doesn't ship CUPS lp by default.
  if (process.platform === 'win32')
    return {
      ok: false,
      error: 'CUPS raw printing is not supported on Windows',
    };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-print-'));
  const file = path.join(tmp, `receipt-${Date.now()}.bin`);
  await fs.writeFile(file, opts.data);

  const args: string[] = [];
  if (opts.deviceName) args.push('-d', opts.deviceName);
  args.push('-o', 'raw', file);

  const result = await new Promise<{ ok: boolean; error?: string }>(
    (resolve) => {
      const p = spawn('lp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      let settled = false;
      const finish = (r: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(r);
      };
      // A paused or wedged CUPS queue never lets `lp` exit. The print pipeline
      // runs one job at a time, so waiting forever here stops every other
      // receipt on this terminal — kill it and report a normal failure so the
      // retry queue can deal with it.
      const deadline = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish({
          ok: false,
          error: `lp did not respond within ${CUPS_TIMEOUT_MS}ms`,
        });
      }, CUPS_TIMEOUT_MS);
      p.stderr.on('data', (b) => (err += String(b)));
      p.on('error', (e) =>
        finish({ ok: false, error: String((e as any)?.message || e) }),
      );
      p.on('close', (code) =>
        finish(
          code === 0
            ? { ok: true }
            : { ok: false, error: err.trim() || `lp exited with code ${code}` },
        ),
      );
    },
  );

  try {
    await fs.rm(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return result;
}

export type PrinterErrorKind =
  | 'PAPER_OUT'
  | 'OFFLINE'
  | 'COVER_OPEN'
  | 'JAM'
  | 'PERMISSION'
  | 'UNKNOWN';

export function classifyPrinterError(err?: string | null): {
  kind: PrinterErrorKind;
  userMessage: string;
} {
  const raw = String(err || '').trim();
  const s = raw.toLowerCase();
  if (!s)
    return { kind: 'UNKNOWN', userMessage: 'Printer failed (unknown error).' };

  // Paper / media issues
  if (
    /(out of paper|no paper|paper\s*end|paper empty|media empty|tray empty|load paper)/i.test(
      raw,
    )
  ) {
    return {
      kind: 'PAPER_OUT',
      userMessage:
        'Printer is out of paper. Please reload paper and try again.',
    };
  }
  if (/(paper jam|jammed)/i.test(raw)) {
    return {
      kind: 'JAM',
      userMessage:
        'Printer has a paper jam. Please clear the jam and try again.',
    };
  }
  if (/(cover open|open cover|door open)/i.test(raw)) {
    return {
      kind: 'COVER_OPEN',
      userMessage: 'Printer cover is open. Please close it and try again.',
    };
  }

  // Connectivity issues
  if (
    /(econnrefused|ehostunreach|enetunreach|enotfound|etimedout|timeout|network is unreachable|host is down|socket hang up)/i.test(
      raw,
    )
  ) {
    return {
      kind: 'OFFLINE',
      userMessage:
        'Printer is offline/unreachable. Check power, cables/Wi‑Fi, and the IP/port.',
    };
  }

  // Permission / system queue issues
  if (/(permission denied|not authorized|access denied)/i.test(raw)) {
    return {
      kind: 'PERMISSION',
      userMessage:
        'Printing is blocked by system permissions. Ask an admin to allow printer access.',
    };
  }

  return { kind: 'UNKNOWN', userMessage: `Printer error: ${raw}` };
}

export async function sendToPrinterVerbose(
  ip: string,
  port: number,
  data: Buffer,
  opts?: { forceProtocol?: 'RAW' | 'LPR' },
): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    // Protocol selection priority:
    //   1. `opts.forceProtocol` (explicit caller choice — wins)
    //   2. `port === 515` (the standard LPD/LPR port)
    // The legacy `PRINTER_PROTOCOL=LPR` env var is no longer honoured
    // here: now that the UI has explicit port + mode controls, that env
    // could only ever silently override the user's choice (it kept
    // forcing RAW 9100 traffic onto port 515 → ECONNREFUSED). Admins
    // wanting LPR should set port 515 in the printer profile.
    const useLpr =
      opts?.forceProtocol === 'LPR' ||
      (opts?.forceProtocol !== 'RAW' && port === 515);
    if (useLpr) {
      const queue = process.env.PRINTER_LPR_QUEUE || 'printer';
      // sendViaLpr now throws on failure; the outer try/catch wraps it
      // into a structured `{ ok, error, code }` response so the caller
      // gets the real socket error instead of a generic
      // "LPR send failed".
      await sendViaLpr(ip, port || 515, queue, data);
      return { ok: true };
    }

    const { Socket } = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const timeoutMs = Number(process.env.PRINTER_TIMEOUT_MS || 5000);
      let settled = false;
      const settle = (err?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        try {
          socket.destroy();
        } catch (e) {
          void e;
        }
        if (err) reject(err);
        else resolve();
      };
      const onError = (err: any) => settle(err);
      // Bound the *initial connect* explicitly. Node's `socket.setTimeout`
      // only fires on idle activity once the connection is established —
      // it does NOT cap how long the kernel waits when the host is
      // unreachable (EHOSTDOWN / EHOSTUNREACH can sit for 30–75 s on
      // macOS / Linux). Without this hard timer, a Pay button printing
      // to a powered-off printer would stall the whole UI for a minute.
      const connectTimer = setTimeout(
        () =>
          onError(
            Object.assign(new Error('Printer connection timeout'), {
              code: 'ETIMEDOUT',
            }),
          ),
        timeoutMs,
      );
      socket.once('error', onError);
      // Inactivity safety net for the (rare) case where the connection
      // succeeds but the write hangs.
      socket.setTimeout(timeoutMs, () =>
        onError(
          Object.assign(new Error('Printer write timeout'), {
            code: 'ETIMEDOUT',
          }),
        ),
      );
      socket.connect(port, ip, () => {
        clearTimeout(connectTimer);
        socket.write(data, (err) => {
          if (err) return onError(err);
          socket.end(() => settle());
        });
      });
    });
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message || e || 'Send failed');
    const code = e?.code ? String(e.code) : undefined;
    return { ok: false, error: msg, code };
  }
}

/**
 * Minimal LPR (RFC 1179) client. The protocol is request/response:
 *
 *   1. send 0x02 <SP> queue <LF>           wait for ACK (single 0x00 byte)
 *   2. send 0x02 <SP> size <SP> cfname <LF> control bytes <NUL>   wait ACK
 *   3. send 0x03 <SP> size <SP> dfname <LF> data bytes <NUL>      wait ACK
 *
 * The previous implementation expressed this as nested write callbacks
 * and could leak the socket if anything threw between callbacks (the
 * destroy in the error handler ran, but only the FIRST callback chain
 * registered an error listener — once we were N levels deep the cleanup
 * was best-effort). The async/await rewrite makes the cleanup
 * deterministic via try/finally and also returns more useful errors
 * (timeout / refused / NACK / write error) instead of a generic
 * "LPR send failed".
 */
async function sendViaLpr(
  ip: string,
  port: number,
  queue: string,
  data: Buffer,
): Promise<void> {
  const { Socket } = await import('node:net');
  const host = os.hostname?.() || 'pos';
  const dfName = `dfA001${host}`;
  const cfName = `cfA001${host}`;
  const control = Buffer.from(
    [
      `H${host}`,
      `Ppos`,
      `Jticket`,
      `U${dfName}`,
      `Nticket.txt`,
      `ldfA001${host}`,
    ].join('\r\n') + '\r\n',
  );

  const socket = new Socket();
  // Persistent error promise: if the socket errors at any point — even
  // during a `socket.write` we're not awaiting — every step below will
  // reject promptly via Promise.race.
  let socketErr: Error | null = null;
  socket.on('error', (e) => {
    socketErr = e instanceof Error ? e : new Error(String(e));
  });

  const guard = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const check = setInterval(() => {
        if (socketErr) {
          clearInterval(check);
          reject(socketErr);
        }
      }, 10);
      p.then(
        (v) => {
          clearInterval(check);
          resolve(v);
        },
        (e) => {
          clearInterval(check);
          reject(e);
        },
      );
    });

  const connect = () =>
    guard(
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('LPR connect timeout')),
          5000,
        );
        socket.connect(port, ip, () => {
          clearTimeout(t);
          resolve();
        });
      }),
    );

  const write = (buf: Buffer) =>
    guard(
      new Promise<void>((resolve, reject) => {
        socket.write(buf, (err) => (err ? reject(err) : resolve()));
      }),
    );

  const readAck = () =>
    guard(
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('LPR ack timeout')), 5000);
        socket.once('data', (b) => {
          clearTimeout(t);
          if (b[0] === 0) resolve();
          else reject(new Error('LPR NACK'));
        });
      }),
    );

  try {
    await connect();
    // Step 1: announce the queue.
    await write(Buffer.from(`\x02 ${queue}\n`));
    await readAck();
    // Step 2: control file.
    await write(Buffer.from(`\x02 ${control.length} ${cfName}\n`));
    await write(control);
    await write(Buffer.from([0x00]));
    await readAck();
    // Step 3: data file.
    await write(Buffer.from(`\x03 ${data.length} ${dfName}\n`));
    await write(data);
    await write(Buffer.from([0x00]));
    await readAck();
    socket.end();
  } finally {
    // Belt-and-braces: even if `socket.end()` was called above, destroy
    // ensures the file descriptor is released immediately on any throw.
    socket.destroy();
  }
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(Math.round(Number(amount) || 0));
  } catch {
    return `${Math.round(Number(amount) || 0)} ${currency}`;
  }
}

function formatMoneyEscpos(amount: number): string {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return '0';
  // Keep ASCII only for printer compatibility; no trailing .00.
  return String(Math.round(n));
}

function escposText(s: string): Buffer {
  return encodeEscposText(s);
}

function cmdAlign(align: 'left' | 'center' | 'right'): Buffer {
  // ESC a n : 0 left, 1 center, 2 right
  const n = align === 'center' ? 1 : align === 'right' ? 2 : 0;
  return Buffer.from([0x1b, 0x61, n]);
}

function cmdBold(on: boolean): Buffer {
  // ESC E n
  return Buffer.from([0x1b, 0x45, on ? 1 : 0]);
}

function cmdTextSize(size: 'normal' | 'md' | 'lg'): Buffer {
  // GS ! n (bitfields for width/height)
  // normal: 0x00, md: double height, lg: double width+height
  const n = size === 'lg' ? 0x11 : size === 'md' ? 0x01 : 0x00;
  return Buffer.from([0x1d, 0x21, n]);
}

function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  // dd/mm/yyyy hh:mm
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
