/**
 * The time and the business day fiskalizimi works by.
 *
 * The daily cash balance was keyed by the till's local calendar date, from
 * the till's own clock. A PC left on another time zone, or whose clock had
 * drifted, declared "today's" float on the wrong day: the first cash sale
 * after midnight in Tirana was refused (fault 123), or a float was declared
 * twice for one day.
 *
 *   - The day is the date in Albania (`Europe/Tirane`), whatever zone the
 *     PC is set to.
 *   - The clock is corrected by easyPos' own: every easyPos answer carries
 *     an HTTP `Date` header, and the difference to the till's clock is kept
 *     (`noteProviderDate`). Without a recent sample the till clock is used.
 *   - A till more than `CLOCK_DRIFT_ALERT_MS` off is reported
 *     (`clockDriftToReport`), so someone fixes it: receipts print its time.
 */

export const FISCAL_TIME_ZONE = 'Europe/Tirane';
/** An offset older than this is not trusted any more. */
export const CLOCK_SAMPLE_MAX_AGE_MS = 12 * 60 * 60_000;
/** Drift worth telling an admin about. */
export const CLOCK_DRIFT_ALERT_MS = 2 * 60_000;
/** At most one drift alert per this long. */
const DRIFT_ALERT_EVERY_MS = 6 * 60 * 60_000;
/** A round trip slower than this says too little about the server's time. */
const MAX_SAMPLE_ROUND_TRIP_MS = 10_000;

let offsetMs = 0;
let sampledAt = 0;
let lastDriftAlertAt = 0;

/**
 * Record easyPos' clock from a response's `Date` header. `sentAt` and
 * `receivedAt` are the till's clock around the request; the server's time
 * is taken as the middle of that window.
 */
export function noteProviderDate(
  dateHeader: string | null | undefined,
  sentAt: number,
  receivedAt: number,
): void {
  const server = Date.parse(String(dateHeader || ''));
  if (!Number.isFinite(server)) return;
  const roundTrip = receivedAt - sentAt;
  if (!(roundTrip >= 0) || roundTrip > MAX_SAMPLE_ROUND_TRIP_MS) return;
  // The header has one-second resolution: aim at the middle of that second.
  offsetMs = Math.round(server + 500 - (sentAt + roundTrip / 2));
  sampledAt = receivedAt;
}

/** The till's clock error against easyPos, or null with no recent sample. */
export function clockOffsetMs(now = Date.now()): number | null {
  if (!sampledAt || now - sampledAt > CLOCK_SAMPLE_MAX_AGE_MS) return null;
  return offsetMs;
}

/** Now, corrected by easyPos' clock when a recent sample exists. */
export function fiscalNow(now = Date.now()): number {
  return now + (clockOffsetMs(now) ?? 0);
}

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: FISCAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` in Albania for `at` (default: the corrected now). */
export function fiscalDayKey(at: number = fiscalNow()): string {
  const parts = dayFormat.formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The drift to report, once per `DRIFT_ALERT_EVERY_MS`, or null when the
 * clock is fine, unknown, or was reported recently.
 */
export function clockDriftToReport(now = Date.now()): number | null {
  const offset = clockOffsetMs(now);
  if (offset == null || Math.abs(offset) < CLOCK_DRIFT_ALERT_MS) return null;
  if (lastDriftAlertAt && now - lastDriftAlertAt < DRIFT_ALERT_EVERY_MS) {
    return null;
  }
  lastDriftAlertAt = now;
  return offset;
}

/** Test seam. */
export function __resetFiscalClock(): void {
  offsetMs = 0;
  sampledAt = 0;
  lastDriftAlertAt = 0;
}
