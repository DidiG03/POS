/**
 * Telling people about kitchen slips that did not print.
 *
 * A station printer outage used to be visible only on the till, and only
 * for Sends made at the till: a phone's order went to the retry queue in
 * silence, and when the queue gave up nothing told anyone. Now:
 *
 *   - when a slip enters the retry queue, the till and every phone get a
 *     "printer offline" toast and the waiter who sent it a notification;
 *   - when it finally prints, everyone gets a "printer back" toast (from
 *     the printer-station loop);
 *   - when it gives up, the waiter and every admin get a notification
 *     pointing at Printer jobs, where it can be reprinted.
 */
import { prisma } from '@db/client';
import { broadcastPrinterEvent } from './realtime';

function where(payload: any): string {
  const area = String(payload?.area || '').trim();
  const label = String(payload?.tableLabel || '').trim();
  return [area, label].filter(Boolean).join(' ') || 'a table';
}

function printerLabel(name?: string | null, payload?: any): string {
  const n = String(name || payload?.meta?.routeLabel || '').trim();
  return n ? `The ${n} printer` : 'A kitchen printer';
}

async function notifyUser(userId: unknown, message: string): Promise<void> {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return;
  await prisma.notification
    .create({ data: { userId: id, type: 'OTHER' as any, message } as any })
    .catch(() => undefined);
}

export async function notifyStationPrintQueued(input: {
  payload: any;
  printerName?: string | null;
}): Promise<void> {
  const printer = printerLabel(input.printerName, input.payload);
  const isVoid = Boolean(input.payload?.meta?.voidSlip);
  try {
    broadcastPrinterEvent({
      level: 'error',
      kind: 'station',
      message: `${printer} is offline. Slips will print when it is back.`,
      at: Date.now(),
      context: {
        area: input.payload?.area,
        tableLabel: input.payload?.tableLabel,
        printer: input.printerName || null,
      },
    });
  } catch {
    // best-effort
  }
  await notifyUser(
    input.payload?.meta?.userId,
    `${printer} is offline: the ${isVoid ? 'void slip' : 'order'} for ${where(input.payload)} has not printed yet. It will print when the printer is back.`,
  );
}

export async function notifyStationPrintFailed(input: {
  payload: any;
  printerName?: string | null;
  error?: string | null;
}): Promise<void> {
  const printer = printerLabel(input.printerName, input.payload);
  const message = `${printer} could not print the ${input.payload?.meta?.voidSlip ? 'void slip' : 'order'} for ${where(input.payload)}. Tell the kitchen, or reprint it from Printer jobs.`;
  try {
    broadcastPrinterEvent({
      level: 'error',
      kind: 'station',
      message,
      detail: input.error || null,
      at: Date.now(),
      context: {
        area: input.payload?.area,
        tableLabel: input.payload?.tableLabel,
      },
    });
  } catch {
    // best-effort
  }
  await notifyUser(input.payload?.meta?.userId, message);
  const admins = (await prisma.user
    .findMany({ where: { role: 'ADMIN', active: true } as any, take: 50 })
    .catch(() => [])) as Array<{ id: number }>;
  for (const a of admins) {
    if (Number(a.id) === Number(input.payload?.meta?.userId)) continue;
    await notifyUser(a.id, message);
  }
}
