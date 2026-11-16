/**
 * How long one sitting (a party at a table) can last, for every lookback
 * that has to find the start of the sitting a sale or a line belongs to.
 *
 * Several of them assumed 12 hours, because the till used to void any
 * table open longer than that. A venue can now let tables stay open up to
 * `OVERDUE_TABLES_MAX_HOURS` (`overdueTables.ts`), and those lookbacks
 * then missed the start of a long sitting: the sale was credited to whoever
 * took the payment, a request's lines could be asked for again, a repeated
 * kitchen slip printed as new.
 *
 * The limit is the venue's overdue hours plus an hour, never less than
 * `MIN_SITTING_LOOKBACK_MS`, so venues on the default see no change. It is
 * kept here, updated whenever the settings are read or saved (`core.ts`),
 * so the code that needs it does not have to read the settings itself.
 */
import { overdueTablesConfig } from './overdueTables';

const HOUR_MS = 60 * 60 * 1000;
export const MIN_SITTING_LOOKBACK_MS = 13 * HOUR_MS;

let lookbackMs = MIN_SITTING_LOOKBACK_MS;

/** The limit for these settings. */
export function sittingLookbackFor(settings: unknown): number {
  const { hours } = overdueTablesConfig(settings);
  return Math.max(MIN_SITTING_LOOKBACK_MS, (hours + 1) * HOUR_MS);
}

/** Called by `core.ts` with the settings it just read or saved. */
export function noteSittingSettings(settings: unknown): void {
  lookbackMs = sittingLookbackFor(settings);
}

/** How far back the start of the current sitting can be. */
export function sittingLookbackMs(): number {
  return lookbackMs;
}
