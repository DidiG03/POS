/**
 * Tell admins whose PIN is shorter than the 4 characters a new PIN needs
 * (`@shared/staffPin`). Such a PIN still signs in, so nobody is locked out
 * by the rule; it is reported when used, at most once a day per person.
 */
import { prisma } from '@db/client';
import { isShortStaffPin } from '@shared/staffPin';
import { notifyAdminsAndActor } from './adminAlerts';
import { logIgnored } from './logIgnored';

export const SHORT_PIN_NOTIFIED_KEY = 'pins:shortNotified';
const DAY_MS = 24 * 60 * 60_000;

export async function noticeShortPin(input: {
  userId: number;
  displayName: string;
  role: unknown;
  pin: unknown;
  now?: number;
}): Promise<boolean> {
  if (!isShortStaffPin(input.pin, input.role)) return false;
  const now = input.now ?? Date.now();
  try {
    const row = await prisma.syncState.findUnique({
      where: { key: SHORT_PIN_NOTIFIED_KEY },
    });
    const map = ((row as any)?.valueJson || {}) as Record<string, string>;
    const last = Date.parse(map[String(input.userId)] || '');
    if (Number.isFinite(last) && now - last < DAY_MS) return false;
    map[String(input.userId)] = new Date(now).toISOString();
    await prisma.syncState.upsert({
      where: { key: SHORT_PIN_NOTIFIED_KEY },
      create: { key: SHORT_PIN_NOTIFIED_KEY, valueJson: map as any },
      update: { valueJson: map as any },
    });
    await notifyAdminsAndActor({
      type: 'SECURITY',
      message: `${input.displayName || `User #${input.userId}`}'s PIN is shorter than 4 characters and easy to guess. Set a new PIN for them in Admin → Staff.`,
    });
    return true;
  } catch (e) {
    logIgnored('shortPinNotice', false)(e);
    return false;
  }
}
