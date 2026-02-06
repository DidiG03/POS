import type { SettingsDTO } from '@shared/ipc';
import os from 'node:os';
import { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ESC/POS helpers
const ESC = Buffer.from([0x1b]);
const GS = Buffer.from([0x1d]);

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
  meta?: any; // optional (payment metadata like discounts)
};

export function buildEscposTicket(payload: TicketPrintPayload, settings: SettingsDTO): Buffer {
  const now = payload.printedAtIso ? new Date(payload.printedAtIso) : new Date();
  const nowStr = formatDateTime(now);
  const restaurant = settings.restaurantName || 'Restaurant';
  const currency = settings.currency || 'EUR';

  const lines: Buffer[] = [];
  lines.push(ESC, Buffer.from('@'));

  const meta: any = payload.meta || {};
  const kind = String(meta?.kind || '').toUpperCase();
  const stationLabel = String(meta?.station || '').toUpperCase();
  const routeLabel = String(meta?.routeLabel || '').trim();
  const hidePrices = Boolean(meta?.hidePrices) || kind === 'ORDER';
  const itemsToPrint: TicketPrintItem[] = hidePrices ? (payload.items || []) : aggregateTicketItems(payload.items || []);

  // Header (restaurant-style)
  if (kind === 'ORDER') {
    // For kitchen/bar slips: keep header minimal (no big bold restaurant title)
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(false));
    lines.push(cmdTextSize('normal'));
    // Optional small brand line (can be removed entirely if you prefer)
    lines.push(escposText(`${restaurant}\n`));
  } else {
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(true));
    lines.push(cmdTextSize('lg'));
    lines.push(escposText(`${restaurant}\n`));
    lines.push(cmdTextSize('normal'));
    lines.push(cmdBold(false));
  }
  if (kind === 'ORDER') {
    lines.push(cmdBold(true));
    const top = routeLabel ? routeLabel.toUpperCase() : (stationLabel && stationLabel !== 'ALL' ? stationLabel : '');
    lines.push(escposText(`${top ? top + ' ' : ''}ORDER\n`));
    lines.push(cmdBold(false));
  }
  lines.push(escposText('--------------------------------\n'));
  lines.push(cmdAlign('left'));
  // Avoid Unicode bullets / fancy separators (often render as garbage on ESC/POS)
  const tableInfo = `${payload.area} - ${payload.tableLabel}`;
  lines.push(escposText(`${tableInfo}\n`));
  if (payload.covers) lines.push(escposText(`Covers: ${payload.covers}\n`));
  if (payload.userName) lines.push(escposText(`Waiter: ${payload.userName}\n`));
  lines.push(escposText(`${nowStr}\n`));
  lines.push(escposText('--------------------------------\n'));

  // Items
  let subtotal = 0;
  let vat = 0;
  const vatEnabled = meta?.vatEnabled !== false;
  for (const it of itemsToPrint) {
    const qty = Number(it.qty || 1);
    const linePrice = Number(it.unitPrice || 0) * qty;
    subtotal += linePrice;
    if (vatEnabled) vat += linePrice * Number(it.vatRate || 0);
    // 32-col layout: left 22, right 10
    const left = `${qty} x ${String(it.name || '')}`;
    const right = hidePrices ? '' : formatMoneyEscpos(linePrice);
    lines.push(escposText(`${padRight(left, 22)}${padLeft(right, 10)}\n`));
    if (it.note) lines.push(escposText(`  - ${String(it.note)}\n`));
  }

  // Totals (skip for ORDER slips)
  const scAmt = Number(meta?.serviceChargeAmount || 0);
  const discountAmt = Number(meta?.discountAmount || 0);
  const baseTotal = subtotal + vat;
  const totalAfter = Number(meta?.totalAfter);
  const fallbackTotal = Math.max(0, baseTotal + (Number.isFinite(scAmt) ? scAmt : 0) - (Number.isFinite(discountAmt) ? discountAmt : 0));
  const totalFinal = Number.isFinite(totalAfter) ? Math.max(0, totalAfter) : fallbackTotal;
  if (!hidePrices) {
    lines.push(escposText('--------------------------------\n'));
    lines.push(escposText(`${padRight('Subtotal', 22)}${padLeft(formatMoneyEscpos(subtotal), 10)}\n`));
    if (vatEnabled) lines.push(escposText(`${padRight('VAT', 22)}${padLeft(formatMoneyEscpos(vat), 10)}\n`));
    if (Number.isFinite(scAmt) && scAmt > 0) {
      const mode = String(meta?.serviceChargeMode || '').toUpperCase();
      const v = meta?.serviceChargeValue;
      const label =
        mode === 'PERCENT' && Number.isFinite(Number(v))
          ? `Service (${Number(v)}%)`
          : 'Service charge';
      lines.push(escposText(`${padRight(label, 22)}${padLeft(formatMoneyEscpos(scAmt), 10)}\n`));
    }
    if (Number.isFinite(discountAmt) && discountAmt > 0) {
      const dtype = String(meta?.discountType || '').toUpperCase();
      const dval = meta?.discountValue;
      const label =
        dtype === 'PERCENT' && Number.isFinite(Number(dval))
          ? `Discount (${Number(dval)}%)`
          : 'Discount';
      lines.push(escposText(`${padRight(label, 22)}${padLeft('-' + formatMoneyEscpos(discountAmt), 10)}\n`));
    }
    lines.push(cmdBold(true));
    lines.push(cmdTextSize('md'));
    lines.push(escposText(`${padRight('TOTAL', 22)}${padLeft(formatMoneyEscpos(totalFinal), 10)}\n`));
    lines.push(cmdTextSize('normal'));
    lines.push(cmdBold(false));
    lines.push(escposText(`${padRight('Currency', 22)}${padLeft(String(currency).slice(0, 3).toUpperCase(), 10)}\n`));
  }

  // Payment section (only for payment receipts)
  if (kind === 'PAYMENT') {
    const method = String(meta?.method || meta?.paymentMethod || '').toUpperCase();
    const approvedBy = String(meta?.managerApprovedByName || '').trim();
    lines.push(escposText('--------------------------------\n'));
    lines.push(cmdAlign('center'));
    lines.push(cmdBold(true));
    lines.push(escposText('PAID\n'));
    lines.push(cmdBold(false));
    lines.push(cmdAlign('left'));
    if (method) lines.push(escposText(`Method: ${method}\n`));
    if (approvedBy) lines.push(escposText(`Approved: ${approvedBy}\n`));
  }

  if (payload.note) {
    lines.push(escposText('\nNote:\n'));
    lines.push(escposText(`${payload.note}\n`));
  }

  // Footer and cut
  lines.push(escposText('\n'));
  lines.push(cmdAlign('center'));
  lines.push(escposText('Thank you!\n'));
  lines.push(escposText('Powered by Code Orbit POS\n'));
  lines.push(cmdAlign('left'));
  lines.push(escposText('\n'));
  lines.push(GS, Buffer.from('V'), Buffer.from([0x41]), Buffer.from([0x10])); // partial cut

  return Buffer.concat(lines);
}

export function buildHtmlReceipt(payload: TicketPrintPayload, settings: SettingsDTO): string {
  const now = payload.printedAtIso ? new Date(payload.printedAtIso) : new Date();
  const nowStr = formatDateTime(now);
  const restaurant = settings.restaurantName || 'Restaurant';
  const currency = settings.currency || 'EUR';
  const meta: any = payload.meta || {};
  const vatEnabled = meta?.vatEnabled !== false;
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
  const subtotal = items.reduce((sum, it) => sum + Number(it.unitPrice || 0) * Number(it.qty || 1), 0);
  const vat = vatEnabled ? items.reduce((sum, it) => sum + Number(it.unitPrice || 0) * Number(it.qty || 1) * Number(it.vatRate || 0), 0) : 0;
  const scAmt = Number(meta?.serviceChargeAmount || 0);
  const discountAmt = Number(meta?.discountAmount || 0);
  const baseTotal = subtotal + vat;
  const totalAfter = Number(meta?.totalAfter);
  const fallbackTotal = Math.max(0, baseTotal + (Number.isFinite(scAmt) ? scAmt : 0) - (Number.isFinite(discountAmt) ? discountAmt : 0));
  const totalFinal = Number.isFinite(totalAfter) ? Math.max(0, totalAfter) : fallbackTotal;

  const rows = items
    .map((it) => {
      const qty = Number(it.qty || 1);
      const line = Number(it.unitPrice || 0) * qty;
      const note = it.note ? `<div class="note">- ${safe(it.note)}</div>` : '';
      const right = hidePrices ? '' : safe(formatMoney(line, currency));
      return `<div class="row"><div class="left">${safe(`${qty} x ${it.name}`)}</div><div class="right">${right}</div></div>${note}`;
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
  const paidBlock =
    kind === 'PAYMENT'
      ? `<div class="sep"></div><div class="paid">PAID</div>${meta?.method || meta?.paymentMethod ? `<div class="small">Method: ${safe(String(meta?.method || meta?.paymentMethod).toUpperCase())}</div>` : ''}`
      : '';

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: 80mm auto; margin: 4mm; }
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; color: #000; }
      .title { text-align: center; font-weight: 800; font-size: 18px; margin: 2px 0 6px; }
      .titleSlip { text-align: center; font-weight: 500; font-size: 12px; margin: 2px 0 6px; }
      .sep { border-top: 1px dashed #000; margin: 6px 0; }
      .small { font-size: 11px; }
      .row { display: flex; justify-content: space-between; gap: 8px; }
      .left { flex: 1; word-break: break-word; }
      .right { min-width: 70px; text-align: right; white-space: nowrap; }
      .note { margin-left: 8px; font-size: 11px; }
      .footer { text-align: center; margin-top: 10px; }
      .paid { text-align: center; font-weight: 800; font-size: 14px; margin: 2px 0; }
    </style>
  </head>
  <body>
    <div class="${kind === 'ORDER' ? 'titleSlip' : 'title'}">${safe(restaurant)}</div>
    ${kind === 'ORDER' ? `<div class="paid">${safe(`${(routeLabel ? routeLabel.toUpperCase() : (stationLabel && stationLabel !== 'ALL' ? stationLabel : '') )}${(routeLabel || (stationLabel && stationLabel !== 'ALL')) ? ' ' : ''}ORDER`)}</div>` : ''}
    <div class="small">${safe(`${payload.area} - ${payload.tableLabel}`)}</div>
    ${payload.covers ? `<div class="small">Covers: ${safe(payload.covers)}</div>` : ''}
    ${payload.userName ? `<div class="small">Waiter: ${safe(payload.userName)}</div>` : ''}
    <div class="small">${safe(nowStr)}</div>
    <div class="sep"></div>
    ${rows}
    ${hidePrices ? '' : `<div class="sep"></div>
    <div class="row"><div class="left">Subtotal</div><div class="right">${safe(formatMoney(subtotal, currency))}</div></div>
    ${vatEnabled ? `<div class="row"><div class="left">VAT</div><div class="right">${safe(formatMoney(vat, currency))}</div></div>` : ''}
    ${scLine}
    ${discountLine}
    <div class="row" style="font-weight:700"><div class="left">TOTAL</div><div class="right">${safe(formatMoney(totalFinal, currency))}</div></div>`}
    ${payload.note ? `<div class="sep"></div><div class="small">Note:</div><div class="small">${safe(payload.note)}</div>` : ''}
    ${paidBlock}
    <div class="footer small">Thank you!</div>
    <div class="footer small">Powered by Code Orbit POS</div>
  </body>
</html>`;
}

export async function printHtmlToSystemPrinter(opts: { html: string; deviceName?: string; silent?: boolean }): Promise<{ ok: boolean; error?: string }> {
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
    await win.loadURL(url);
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      win.webContents.print({ silent, deviceName: opts.deviceName, printBackground: true }, (success, reason) => {
        resolve(success ? { ok: true } : { ok: false, error: reason || 'Print failed' });
      });
    });
    return result;
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e || 'Print failed') };
  } finally {
    try { win.destroy(); } catch (e) { void e; }
  }
}

export async function sendToCupsRawPrinter(opts: { deviceName?: string; data: Buffer }): Promise<{ ok: boolean; error?: string }> {
  // macOS/Linux only. Windows doesn't ship CUPS lp by default.
  if (process.platform === 'win32') return { ok: false, error: 'CUPS raw printing is not supported on Windows' };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pos-print-'));
  const file = path.join(tmp, `receipt-${Date.now()}.bin`);
  await fs.writeFile(file, opts.data);

  const args: string[] = [];
  if (opts.deviceName) args.push('-d', opts.deviceName);
  args.push('-o', 'raw', file);

  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('lp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b) => (err += String(b)));
    p.on('error', (e) => resolve({ ok: false, error: String((e as any)?.message || e) }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `lp exited with code ${code}` }));
  });

  try { await fs.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  return result;
}

export async function sendToPrinter(ip: string, port: number, data: Buffer): Promise<boolean> {
  const r = await sendToPrinterVerbose(ip, port, data);
  return r.ok;
}

export type PrinterErrorKind = 'PAPER_OUT' | 'OFFLINE' | 'COVER_OPEN' | 'JAM' | 'PERMISSION' | 'UNKNOWN';

export function classifyPrinterError(err?: string | null): { kind: PrinterErrorKind; userMessage: string } {
  const raw = String(err || '').trim();
  const s = raw.toLowerCase();
  if (!s) return { kind: 'UNKNOWN', userMessage: 'Printer failed (unknown error).' };

  // Paper / media issues
  if (/(out of paper|no paper|paper\s*end|paper empty|media empty|tray empty|load paper)/i.test(raw)) {
    return { kind: 'PAPER_OUT', userMessage: 'Printer is out of paper. Please reload paper and try again.' };
  }
  if (/(paper jam|jammed)/i.test(raw)) {
    return { kind: 'JAM', userMessage: 'Printer has a paper jam. Please clear the jam and try again.' };
  }
  if (/(cover open|open cover|door open)/i.test(raw)) {
    return { kind: 'COVER_OPEN', userMessage: 'Printer cover is open. Please close it and try again.' };
  }

  // Connectivity issues
  if (/(econnrefused|ehostunreach|enetunreach|enotfound|etimedout|timeout|network is unreachable|host is down|socket hang up)/i.test(raw)) {
    return { kind: 'OFFLINE', userMessage: 'Printer is offline/unreachable. Check power, cables/Wi‑Fi, and the IP/port.' };
  }

  // Permission / system queue issues
  if (/(permission denied|not authorized|access denied)/i.test(raw)) {
    return { kind: 'PERMISSION', userMessage: 'Printing is blocked by system permissions. Ask an admin to allow printer access.' };
  }

  return { kind: 'UNKNOWN', userMessage: `Printer error: ${raw}` };
}

export async function sendToPrinterVerbose(ip: string, port: number, data: Buffer): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    if (port === 515 || process.env.PRINTER_PROTOCOL === 'LPR') {
      const queue = process.env.PRINTER_LPR_QUEUE || 'printer';
      const ok = await sendViaLpr(ip, 515, queue, data);
      return ok ? { ok: true } : { ok: false, error: 'LPR send failed' };
    }

    const { Socket } = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const timeoutMs = Number(process.env.PRINTER_TIMEOUT_MS || 5000);
      const onError = (err: any) => {
        try { socket.destroy(); } catch (e) { void e; }
        reject(err);
      };
      socket.once('error', onError);
      socket.setTimeout(timeoutMs, () => onError(Object.assign(new Error('Printer connection timeout'), { code: 'ETIMEDOUT' })));
      socket.connect(port, ip, () => {
        socket.write(data, (err) => {
          if (err) return onError(err);
          socket.end();
          resolve();
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

// Minimal LPR (RFC 1179) client to send a raw job via Windows LPD or LPR printers
async function sendViaLpr(ip: string, port: number, queue: string, data: Buffer): Promise<boolean> {
  const { Socket } = await import('node:net');
  const host = os.hostname?.() || 'pos';
  // Build a minimal control file
  const dfName = `dfA001${host}`;
  const cfName = `cfA001${host}`;
  const cfLines = [
    `H${host}`,
    `Ppos`,
    `Jticket`,
    `U${dfName}`,
    `Nticket.txt`,
    `ldfA001${host}`,
  ];
  const control = Buffer.from(cfLines.join('\r\n') + '\r\n');
  return await new Promise<boolean>((resolve, reject) => {
    const s = new Socket();
    const onError = (e: any) => {
      try { s.destroy(); } catch (err) { void err; }
      reject(e);
    };
    s.once('error', onError);
    s.setTimeout(5000, () => onError(new Error('LPR timeout')));
    s.connect(port, ip, () => {
      const write = (buf: Buffer, cb: () => void) => s.write(buf, cb);
      const readAck = (cb: () => void) => s.once('data', (b) => (b[0] === 0 ? cb() : onError(new Error('LPR NACK'))));
      // 02 <SP> queue <LF>
      write(Buffer.from([0x02]), () => {});
      write(Buffer.from(` ${queue}\n`), () => {
        readAck(() => {
          // control file: 02 <SP> size <SP> cfname <LF> <contents> <NUL>
          write(Buffer.from(`\x02 ${control.length} ${cfName}\n`), () => {
            write(control, () => {
              write(Buffer.from([0x00]), () => {
                readAck(() => {
                  // data file: 03 <SP> size <SP> dfname <LF> <data> <NUL>
                  write(Buffer.from(`\x03 ${data.length} ${dfName}\n`), () => {
                    write(data, () => {
                      write(Buffer.from([0x00]), () => {
                        readAck(() => {
                          try { s.end(); } catch (e) { void e; }
                          resolve(true);
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

function padRight(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + ' '.repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return ' '.repeat(len - s.length) + s;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
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
  // Replace common problematic Unicode chars.
  const normalized = String(s)
    .replaceAll('•', '-')
    .replaceAll('€', 'EUR')
    .replaceAll('\u00A0', ' '); // NBSP
  // Strip non-ASCII characters (ESC/POS typically uses single-byte code pages).
  const ascii = normalized.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
  return Buffer.from(ascii, 'ascii');
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


