import type { SettingsDTO, TicketPrintMeta } from '@shared/ipc';
import { resolveVatEnabledFromMeta } from '@shared/vatFromFiscal';
import { effectiveVatRate, splitGrossVat } from '@shared/ticketRevenue';
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
  formatTwoCol,
  layoutFromSettings,
  wrapEscposText,
  type ReceiptLayout,
} from './escposEncode';

// ESC/POS helpers
const ESC = Buffer.from([0x1b]);
const GS = Buffer.from([0x1d]);

function cmdPrinterInit(): Buffer[] {
  return [ESC, Buffer.from('@'), ESC_POS_FONT_A, ESC_POS_PC850];
}

function twoCol(left: string, right: string, layout: ReceiptLayout): Buffer[] {
  return formatTwoCol(left, right, layout)
    .split('\n')
    .map((ln) => escposText(`${ln}\n`));
}

function escposQrCode(
  data: string,
  options?: { moduleSize?: number; align?: 'left' | 'center' | 'right' },
): Buffer {
  const text = String(data || '');
  const align = options?.align ?? 'center';
  const alignByte = align === 'center' ? 49 : align === 'right' ? 50 : 48;
  let moduleSize = options?.moduleSize;
  if (moduleSize == null) {
    // Long fiscal URLs need a smaller module size on 58mm paper.
    moduleSize = text.length > 140 ? 3 : text.length > 90 ? 4 : 5;
  }
  moduleSize = Math.min(8, Math.max(2, Math.round(moduleSize)));
  const d = Buffer.from(text, 'utf8');
  const storeLen = d.length + 3;
  const pL = storeLen & 0xff;
  const pH = (storeLen >> 8) & 0xff;
  return Buffer.concat([
    // QR-specific alignment (ESC a alone does not center QR on many printers).
    GS,
    Buffer.from([0x28, 0x6b, 0x03, 0x00, 0x31, 0x41, alignByte]),
    GS,
    Buffer.from([0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]),
    GS,
    Buffer.from([0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30]),
    GS,
    Buffer.from([0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    d,
    GS,
    Buffer.from([0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
  ]);
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
  const restaurant = settings.restaurantName || 'Restaurant';
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
  lines.push(escposText('SHIFT REPORT\n'));
  lines.push(cmdBold(false));
  lines.push(escposText(`${layout.sep}\n`));
  lines.push(cmdAlign('left'));
  lines.push(escposText(`Waiter: ${summary.waiterName}\n`));
  lines.push(escposText(`Opened: ${opened}\n`));
  lines.push(escposText(`Closed: ${closed}\n`));
  lines.push(escposText(`${layout.sep}\n`));
  lines.push(...twoCol('Orders', String(summary.orders), layout));
  lines.push(
    ...twoCol('Net sales', formatMoneyEscpos(summary.revenueNet), layout),
  );
  if (summary.vatEnabled) {
    lines.push(...twoCol('VAT', formatMoneyEscpos(summary.revenueVat), layout));
  }
  lines.push(cmdBold(true));
  lines.push(
    ...twoCol('TOTAL', formatMoneyEscpos(summary.revenueGross), layout),
  );
  lines.push(cmdBold(false));
  lines.push(
    ...twoCol('Currency', String(currency).slice(0, 3).toUpperCase(), layout),
  );
  if (summary.byMethod.length > 0) {
    lines.push(escposText(`${layout.sep}\n`));
    lines.push(escposText('By payment:\n'));
    for (const row of summary.byMethod) {
      lines.push(...twoCol(row.method, formatMoneyEscpos(row.amount), layout));
    }
  }
  lines.push(escposText('\n'));
  lines.push(cmdAlign('center'));
  lines.push(escposText('End of shift\n'));
  lines.push(cmdAlign('left'));
  lines.push(escposText('\n'));
  lines.push(GS, Buffer.from('V'), Buffer.from([0x41]), Buffer.from([0x10]));
  return Buffer.concat(lines);
}

export function buildEscposTicket(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
): Buffer {
  const meta: any = payload.meta || {};
  const kindEarly = String(meta?.kind || '').toUpperCase();
  if (kindEarly === 'SHIFT_CLOSE' && meta?.shiftSummary) {
    return buildEscposShiftSummary(
      meta.shiftSummary as ShiftClosePrintSummary,
      settings,
    );
  }

  const now = payload.printedAtIso
    ? new Date(payload.printedAtIso)
    : new Date();
  const nowStr = formatDateTime(now);
  const restaurant = settings.restaurantName || 'Restaurant';
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
  const stationLabel = String(meta?.station || '').toUpperCase();
  const routeLabel = String(meta?.routeLabel || '').trim();
  const hidePrices = Boolean(meta?.hidePrices) || kind === 'ORDER';
  const itemsToPrint: TicketPrintItem[] = hidePrices
    ? payload.items || []
    : aggregateTicketItems(payload.items || []);

  // Header (restaurant-style)
  if (kind === 'ORDER') {
    // For kitchen/bar slips: keep header minimal (no big bold restaurant title)
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(false));
    lines.push(cmdTextSize('normal'));
    // Optional small brand line (can be removed entirely if you prefer)
    for (const ln of wrapEscposText(restaurant, layout.cols)) {
      lines.push(escposText(`${ln}\n`));
    }
  } else {
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(true));
    lines.push(cmdTextSize('lg'));
    for (const ln of wrapEscposText(restaurant, layout.doubleWidthCols)) {
      lines.push(escposText(`${ln}\n`));
    }
    lines.push(cmdTextSize('normal'));
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
  }
  if (kind === 'ORDER') {
    lines.push(cmdBold(true));
    const top = routeLabel
      ? routeLabel.toUpperCase()
      : stationLabel && stationLabel !== 'ALL'
        ? stationLabel
        : '';
    lines.push(escposText(`${top ? top + ' ' : ''}ORDER\n`));
    lines.push(cmdBold(false));
  }
  lines.push(escposText(`${layout.sep}\n`));
  lines.push(cmdAlign('left'));
  // Avoid Unicode bullets / fancy separators (often render as garbage on ESC/POS)
  const tableInfo = `${payload.area} - ${payload.tableLabel}`;
  lines.push(escposText(`${tableInfo}\n`));
  if (payload.covers) lines.push(escposText(`Covers: ${payload.covers}\n`));
  if (payload.userName) lines.push(escposText(`Waiter: ${payload.userName}\n`));
  lines.push(escposText(`${nowStr}\n`));
  lines.push(escposText(`${layout.sep}\n`));

  // Items. Prices are VAT-inclusive (Albanian fiscalization): the gross
  // line already contains the tax, so VAT is extracted, never added on top.
  let grossSubtotal = 0;
  let vat = 0;
  const vatEnabled = resolveVatEnabledFromMeta(meta, settings);
  const defaultVatRate = Number((settings as any)?.defaultVatRate || 0);
  for (const it of itemsToPrint) {
    const qty = Number(it.qty || 1);
    const linePrice = Number(it.unitPrice || 0) * qty;
    grossSubtotal += linePrice;
    if (vatEnabled) {
      const rate = effectiveVatRate(it.vatRate, defaultVatRate);
      vat += splitGrossVat(linePrice, rate).vat;
    }
    if (kind === 'ORDER') {
      lines.push(cmdTextSize('lg'));
      lines.push(cmdBold(true));
      const itemLine = `${qty} x ${String(it.name || '')}`;
      for (const ln of wrapEscposText(itemLine, layout.doubleWidthCols)) {
        lines.push(escposText(`${ln}\n`));
      }
      lines.push(cmdBold(false));
      lines.push(cmdTextSize('normal'));
      if (it.note) {
        for (const ln of wrapEscposText(
          `  - ${String(it.note)}`,
          layout.cols,
        )) {
          lines.push(escposText(`${ln}\n`));
        }
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
    lines.push(...twoCol('Subtotal', formatMoneyEscpos(subtotal), layout));
    if (vatEnabled)
      lines.push(...twoCol('VAT', formatMoneyEscpos(vat), layout));
    if (Number.isFinite(scAmt) && scAmt > 0) {
      const mode = String(meta?.serviceChargeMode || '').toUpperCase();
      const v = meta?.serviceChargeValue;
      const label =
        mode === 'PERCENT' && Number.isFinite(Number(v))
          ? `Service (${Number(v)}%)`
          : 'Service charge';
      lines.push(...twoCol(label, formatMoneyEscpos(scAmt), layout));
    }
    if (Number.isFinite(discountAmt) && discountAmt > 0) {
      const dtype = String(meta?.discountType || '').toUpperCase();
      const dval = meta?.discountValue;
      const label =
        dtype === 'PERCENT' && Number.isFinite(Number(dval))
          ? `Discount (${Number(dval)}%)`
          : 'Discount';
      lines.push(
        ...twoCol(label, '-' + formatMoneyEscpos(discountAmt), layout),
      );
    }
    lines.push(cmdBold(true));
    lines.push(cmdTextSize('md'));
    lines.push(...twoCol('TOTAL', formatMoneyEscpos(totalFinal), layout));
    lines.push(cmdTextSize('normal'));
    lines.push(cmdBold(false));
    lines.push(
      ...twoCol('Currency', String(currency).slice(0, 3).toUpperCase(), layout),
    );
  }

  // Payment section (only for payment receipts)
  if (kind === 'PAYMENT') {
    const method = String(
      meta?.method || meta?.paymentMethod || '',
    ).toUpperCase();
    const approvedBy = String(meta?.managerApprovedByName || '').trim();
    lines.push(escposText(`${layout.sep}\n`));
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(true));
    lines.push(escposText('PAID\n'));
    lines.push(cmdBold(false));
    lines.push(cmdAlign('left'));
    if (method) lines.push(escposText(`Method: ${method}\n`));
    if (approvedBy) lines.push(escposText(`Approved: ${approvedBy}\n`));

    const fiscalNivf = String(meta?.fiscalNivf || '').trim();
    const fiscalNslf = String(meta?.fiscalNslf || '').trim();
    const fiscalLink = String(meta?.fiscalLink || '').trim();
    if (meta?.fiscalEnabled && (fiscalNivf || fiscalNslf || fiscalLink)) {
      const fiscalLineWidth = layout.cols;
      lines.push(escposText(`${layout.sep}\n`));
      lines.push(cmdAlign('center'));
      lines.push(cmdBold(true));
      lines.push(escposText('FISKALIZUAR\n'));
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
      if (fiscalLink) {
        lines.push(escposText('\n'));
        lines.push(cmdAlign('center'));
        lines.push(escposQrCode(fiscalLink, { align: 'center' }));
        lines.push(escposText('\n'));
      }
      lines.push(cmdAlign('left'));
    }
  }

  if (payload.note) {
    lines.push(escposText('\nNote:\n'));
    if (kind === 'ORDER') {
      lines.push(cmdTextSize('md'));
      lines.push(cmdBold(true));
    }
    for (const ln of wrapEscposText(String(payload.note), layout.cols)) {
      lines.push(escposText(`${ln}\n`));
    }
    if (kind === 'ORDER') {
      lines.push(cmdBold(false));
      lines.push(cmdTextSize('normal'));
    }
  }

  // Footer and cut (customer receipts only — kitchen ORDER slips stay minimal)
  lines.push(escposText('\n'));
  if (kind !== 'ORDER') {
    lines.push(cmdAlign('center'));
    lines.push(escposText('Thank you!\n'));
    // Business contact (below Thank you)
    if (bizEmail) lines.push(escposText(`${bizEmail}\n`));
    if (bizWebsite) lines.push(escposText(`${bizWebsite}\n`));
    lines.push(escposText('Powered by OneTap POS\n'));
    lines.push(cmdAlign('left'));
  }
  lines.push(escposText('\n'));
  lines.push(GS, Buffer.from('V'), Buffer.from([0x41]), Buffer.from([0x10])); // partial cut

  return Buffer.concat(lines);
}

export function buildHtmlReceipt(
  payload: TicketPrintPayload,
  settings: SettingsDTO,
): string {
  const now = payload.printedAtIso
    ? new Date(payload.printedAtIso)
    : new Date();
  const nowStr = formatDateTime(now);
  const restaurant = settings.restaurantName || 'Restaurant';
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
  const stationLabel = String(meta?.station || '').toUpperCase();
  const routeLabel = String(meta?.routeLabel || '').trim();
  const hidePrices = Boolean(meta?.hidePrices) || kind === 'ORDER';

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

  const rows = items
    .map((it) => {
      const qty = Number(it.qty || 1);
      const line = Number(it.unitPrice || 0) * qty;
      const note = it.note ? `<div class="note">- ${safe(it.note)}</div>` : '';
      const right = hidePrices ? '' : safe(formatMoney(line, currency));
      const rowClass = kind === 'ORDER' ? 'row orderItem' : 'row';
      return `<div class="${rowClass}"><div class="left">${safe(`${qty} x ${it.name}`)}</div><div class="right">${right}</div></div>${note}`;
    })
    .join('\n');

  const scLine =
    Number.isFinite(scAmt) && scAmt > 0
      ? `<div class="row"><div class="left">${safe(String(meta?.serviceChargeMode || '').toUpperCase() === 'PERCENT' ? `Service (${Number(meta?.serviceChargeValue || 0)}%)` : 'Service charge')}</div><div class="right">${safe(formatMoney(scAmt, currency))}</div></div>`
      : '';
  const discountLine =
    Number.isFinite(discountAmt) && discountAmt > 0
      ? `<div class="row"><div class="left">${safe(String(meta?.discountType || '').toUpperCase() === 'PERCENT' ? `Discount (${Number(meta?.discountValue || 0)}%)` : 'Discount')}</div><div class="right">-${safe(formatMoney(discountAmt, currency))}</div></div>`
      : '';
  const fiscalNivf = String(meta?.fiscalNivf || '').trim();
  const fiscalNslf = String(meta?.fiscalNslf || '').trim();
  const fiscalLink = String(meta?.fiscalLink || '').trim();
  const fiscalBlock =
    kind === 'PAYMENT' &&
    meta?.fiscalEnabled &&
    (fiscalNivf || fiscalNslf || fiscalLink)
      ? `<div class="sep"></div><div class="paid">FISKALIZUAR</div>${fiscalNivf ? `<div class="small">NIVF: ${safe(fiscalNivf)}</div>` : ''}${fiscalNslf ? `<div class="small">NSLF: ${safe(fiscalNslf)}</div>` : ''}${fiscalLink ? `<div class="small"><a href="${safe(fiscalLink)}">${safe(fiscalLink)}</a></div>` : ''}`
      : '';
  const paidBlock =
    kind === 'PAYMENT'
      ? `<div class="sep"></div><div class="paid">PAID</div>${meta?.method || meta?.paymentMethod ? `<div class="small">Method: ${safe(String(meta?.method || meta?.paymentMethod).toUpperCase())}</div>` : ''}${fiscalBlock}`
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
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; color: #000; font-size: 13px; }
      .title { text-align: center; font-weight: 800; font-size: 22px; margin: 2px 0 6px; }
      .titleSlip { text-align: center; font-weight: 500; font-size: 12px; margin: 2px 0 6px; }
      .subtitle { text-align: center; margin: -2px 0 6px; }
      .sep { border-top: 1px dashed #000; margin: 6px 0; }
      .small { font-size: 11px; }
      .row { display: flex; justify-content: space-between; gap: 8px; }
      .left { flex: 1; word-break: break-word; }
      .right { min-width: 70px; text-align: right; white-space: nowrap; }
      .note { margin-left: 8px; font-size: 11px; }
      .orderItem { font-size: 16px; font-weight: 700; line-height: 1.35; margin: 2px 0; }
      .footer { text-align: center; margin-top: 10px; }
      .paid { text-align: center; font-weight: 800; font-size: 14px; margin: 2px 0; }
    </style>
  </head>
  <body>
    <div class="${kind === 'ORDER' ? 'titleSlip' : 'title'}">${safe(restaurant)}</div>
    ${subtitleHtml}
    ${kind === 'ORDER' ? `<div class="paid">${safe(`${routeLabel ? routeLabel.toUpperCase() : stationLabel && stationLabel !== 'ALL' ? stationLabel : ''}${routeLabel || (stationLabel && stationLabel !== 'ALL') ? ' ' : ''}ORDER`)}</div>` : ''}
    <div class="small">${safe(`${payload.area} - ${payload.tableLabel}`)}</div>
    ${payload.covers ? `<div class="small">Covers: ${safe(payload.covers)}</div>` : ''}
    ${payload.userName ? `<div class="small">Waiter: ${safe(payload.userName)}</div>` : ''}
    <div class="small">${safe(nowStr)}</div>
    <div class="sep"></div>
    ${rows}
    ${
      hidePrices
        ? ''
        : `<div class="sep"></div>
    <div class="row"><div class="left">Subtotal</div><div class="right">${safe(formatMoney(subtotal, currency))}</div></div>
    ${vatEnabled ? `<div class="row"><div class="left">VAT</div><div class="right">${safe(formatMoney(vat, currency))}</div></div>` : ''}
    ${scLine}
    ${discountLine}
    <div class="row" style="font-weight:700"><div class="left">TOTAL</div><div class="right">${safe(formatMoney(totalFinal, currency))}</div></div>`
    }
    ${payload.note ? `<div class="sep"></div><div class="small">Note:</div><div class="${kind === 'ORDER' ? 'orderItem' : 'small'}">${safe(payload.note)}</div>` : ''}
    ${paidBlock}
    ${
      kind === 'ORDER'
        ? ''
        : `<div class="footer small">Thank you!</div>
    ${contactHtml}
    <div class="footer small">Powered by OneTap POS</div>`
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
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return amount.toFixed(2) + ' ' + currency;
  }
}

function formatMoneyEscpos(amount: number): string {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return '0.00';
  // Keep ASCII only for printer compatibility.
  return n.toFixed(2);
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
