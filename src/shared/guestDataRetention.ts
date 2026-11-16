/**
 * How long a reservation guest's name, phone number and note are kept.
 *
 * Every other personal record on the till has a limit (notifications a
 * week, security events a year); reservations had none, so a guest's name
 * and number from years ago stayed in the ledger and in every backup.
 * Reservations whose date is older than this are anonymised each night:
 * the name becomes "Guest" and the phone number and note are removed. The
 * party size, table and status stay, so reports still count them.
 */
export const GUEST_RETENTION_CHOICES = [3, 6, 12, 24, 36] as const;
export type GuestRetentionMonths = (typeof GUEST_RETENTION_CHOICES)[number];
export const GUEST_RETENTION_DEFAULT_MONTHS: GuestRetentionMonths = 12;
export const ANONYMISED_GUEST_NAME = 'Guest';

export function guestRetentionMonths(settings: unknown): GuestRetentionMonths {
  const n = Number((settings as any)?.privacy?.reservationGuestMonths);
  return (GUEST_RETENTION_CHOICES as readonly number[]).includes(n)
    ? (n as GuestRetentionMonths)
    : GUEST_RETENTION_DEFAULT_MONTHS;
}

/** Why a saved `privacy.reservationGuestMonths` cannot be used, or null. */
export function guestRetentionProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  return (GUEST_RETENTION_CHOICES as readonly number[]).includes(Number(raw))
    ? null
    : `Reservation guests: keep their details for ${GUEST_RETENTION_CHOICES.join(', ')} months.`;
}

/** Reservations dated before this are anonymised. */
export function guestRetentionCutoff(months: number, now: Date): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d;
}
