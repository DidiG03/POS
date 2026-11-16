/** Nightly anonymising of old reservation guests (`guestDataRetention.ts`). */
import { prisma } from '@db/client';
import {
  ANONYMISED_GUEST_NAME,
  guestRetentionCutoff,
  guestRetentionMonths,
} from '@shared/guestDataRetention';
import { coreServices } from './core';
import { logSecurityEvent } from './security';
import { logIgnored } from './logIgnored';

type Db = {
  reservation: {
    updateMany: (args: any) => Promise<{ count: number }>;
  };
};

/** Anonymise reservations older than the venue's limit. Returns how many. */
export async function anonymiseOldReservations(input: {
  months: number;
  now?: Date;
  db?: Db;
}): Promise<number> {
  const db = input.db ?? (prisma as unknown as Db);
  const cutoff = guestRetentionCutoff(input.months, input.now ?? new Date());
  const res = await db.reservation.updateMany({
    where: {
      startsAt: { lt: cutoff },
      OR: [
        { customerName: { not: ANONYMISED_GUEST_NAME } },
        { customerPhone: { not: null } },
        { note: { not: null } },
      ],
    },
    data: {
      customerName: ANONYMISED_GUEST_NAME,
      customerPhone: null,
      note: null,
    },
  });
  return Number(res?.count || 0);
}

let timer: NodeJS.Timeout | null = null;

export function startReservationRetentionLoop(): void {
  if (timer) return;
  const run = async () => {
    const settings = await coreServices.readSettings().catch(() => null);
    if (!settings) return;
    const months = guestRetentionMonths(settings);
    const count = await anonymiseOldReservations({ months });
    if (count > 0) {
      console.log(
        `[reservations] anonymised ${count} reservation(s) older than ${months} months`,
      );
      logSecurityEvent('reservation_guests_anonymised', { count, months });
    }
  };
  const safeRun = () =>
    void run().catch(logIgnored('reservationRetention', undefined));
  setTimeout(safeRun, 90_000).unref?.();
  timer = setInterval(safeRun, 24 * 60 * 60 * 1000);
  timer.unref?.();
}

export function stopReservationRetentionLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
