import type { SettingsDTO } from '@shared/ipc';
import os from 'node:os';

// ESC/POS helpers
const ESC = Buffer.from([0x1b]);
const GS = Buffer.from([0x1d]);

export type TicketPrintItem = { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string };
export type TicketPrintPayload = {
  area: string;
  tableLabel: string;
  covers?: number | null;
  items: TicketPrintItem[];
  note?: string | null;
  printedAtIso?: string; // optional, defaults to now
  userName?: string; // optional waiter name
};

export function buildEscposTicket(payload: TicketPrintPayload, settings: SettingsDTO): Buffer {
  const nowIso = payload.printedAtIso || new Date().toISOString();
  const restaurant = settings.restaurantName || 'Restaurant';
  const currency = settings.currency || 'EUR';

  const lines: Buffer[] = [];
  lines.push(ESC, Buffer.from('@'));

  // Header
  lines.push(Buffer.from(`\n${restaurant}\n`));
  lines.push(Buffer.from('--------------------------------\n'));
  const tableInfo = `${payload.area} • ${payload.tableLabel}`;
  const coversInfo = payload.covers ? `Covers: ${payload.covers}` : '';
  lines.push(Buffer.from(`${tableInfo}${coversInfo ? ' | ' + coversInfo : ''}\n`));
  if (payload.userName) lines.push(Buffer.from(`By: ${payload.userName}\n`));
  lines.push(Buffer.from(`${nowIso}\n`));
  lines.push(Buffer.from('--------------------------------\n'));

  // Items
  let subtotal = 0;
  let vat = 0;
  for (const it of payload.items) {
    const qty = Number(it.qty || 1);
    const linePrice = Number(it.unitPrice || 0) * qty;
    subtotal += linePrice;
    vat += linePrice * Number(it.vatRate || 0);
    const priceStr = formatMoney(linePrice, currency);
    const nameStr = `${qty} x ${it.name}`;
    lines.push(Buffer.from(`${padRight(nameStr, 24)}${padLeft(priceStr, 8)}\n`));
    if (it.note) lines.push(Buffer.from(`  ${it.note}\n`));
  }

  // Totals
  lines.push(Buffer.from('--------------------------------\n'));
  lines.push(Buffer.from(`${padRight('Subtotal', 24)}${padLeft(formatMoney(subtotal, currency), 8)}\n`));
  lines.push(Buffer.from(`${padRight('VAT', 24)}${padLeft(formatMoney(vat, currency), 8)}\n`));
  lines.push(Buffer.from(`${padRight('TOTAL', 24)}${padLeft(formatMoney(subtotal + vat, currency), 8)}\n`));

  if (payload.note) {
    lines.push(Buffer.from('\nNote:\n'));
    lines.push(Buffer.from(`${payload.note}\n`));
  }

  // Footer and cut
  lines.push(Buffer.from('\n\nThank you!\n\n'));
  lines.push(GS, Buffer.from('V'), Buffer.from([0x41]), Buffer.from([0x10])); // partial cut

  return Buffer.concat(lines);
}

export async function sendToPrinter(ip: string, port: number, data: Buffer): Promise<boolean> {
  try {
    if (port === 515 || process.env.PRINTER_PROTOCOL === 'LPR') {
      const queue = process.env.PRINTER_LPR_QUEUE || 'printer';
      return await sendViaLpr(ip, 515, queue, data);
    } else {
      const { Socket } = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const socket = new Socket();
        socket.once('error', (err) => {
          try { socket.destroy(); } catch {}
          reject(err);
        });
        socket.connect(port, ip, () => {
          socket.write(data, () => {
            socket.end();
            resolve();
          });
        });
      });
      return true;
    }
  } catch {
    return false;
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
      try { s.destroy(); } catch {}
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
                          try { s.end(); } catch {}
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



