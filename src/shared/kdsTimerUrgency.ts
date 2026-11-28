/** Minutes on NEW tickets before the ticket turns amber (default). */
export const KDS_TIMER_WARNING_MINUTES = 8;

/** Minutes on NEW tickets before the ticket turns red (default). */
export const KDS_TIMER_LATE_MINUTES = 15;

/** The venue's ticket-age limits (Admin › Settings › Kitchen display). */
export function kdsTimerThresholds(settings: any): {
  warningMinutes: number;
  lateMinutes: number;
} {
  const k = settings?.kds || {};
  const warn = Math.round(Number(k.ticketAmberMinutes));
  const late = Math.round(Number(k.ticketRedMinutes));
  const w =
    Number.isFinite(warn) && warn >= 1 && warn <= 120
      ? warn
      : KDS_TIMER_WARNING_MINUTES;
  const l =
    Number.isFinite(late) && late > w && late <= 240
      ? late
      : Math.max(w + 1, KDS_TIMER_LATE_MINUTES);
  return { warningMinutes: w, lateMinutes: l };
}

/** A note asking for speed, or warning of an allergy (shown big on the card). */
export function kdsNoteFlags(note: unknown): {
  rush: boolean;
  allergy: boolean;
} {
  const s = String(note || '').toLowerCase();
  return {
    rush: /\b(rush|urgent|asap|priority|quick|fast)\b|shpejt|urgjent/.test(s),
    allergy:
      /allerg|alergj|gluten|celiac|coeliac|nut\b|nuts|peanut|arr[eë]|lactose|laktoz|vegan|shellfish|fruta deti/.test(
        s,
      ),
  };
}

export type KdsTimerUrgency = 'fresh' | 'warning' | 'late';

const WARNING_SEC = KDS_TIMER_WARNING_MINUTES * 60;
const LATE_SEC = KDS_TIMER_LATE_MINUTES * 60;

export function kdsElapsedSeconds(
  iso: string,
  nowMs: number = Date.now(),
): number | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

export function kdsTimerUrgencyFromElapsed(
  elapsedSec: number,
  th?: { warningMinutes: number; lateMinutes: number },
): KdsTimerUrgency {
  const late = th ? th.lateMinutes * 60 : LATE_SEC;
  const warn = th ? th.warningMinutes * 60 : WARNING_SEC;
  if (elapsedSec >= late) return 'late';
  if (elapsedSec >= warn) return 'warning';
  return 'fresh';
}

export function kdsTimerUrgencyFromIso(
  iso: string,
  nowMs?: number,
  th?: { warningMinutes: number; lateMinutes: number },
): KdsTimerUrgency | null {
  const elapsed = kdsElapsedSeconds(iso, nowMs);
  if (elapsed == null) return null;
  return kdsTimerUrgencyFromElapsed(elapsed, th);
}

/** Whole-card colour by age, with the word for it (not colour alone). */
export function kdsTimerUrgencyCardClass(urgency: KdsTimerUrgency): string {
  switch (urgency) {
    case 'fresh':
      return 'kds-age-fresh';
    case 'warning':
      return 'kds-age-warning';
    case 'late':
      return 'kds-age-late';
  }
}

/** Tailwind classes for the live timer label on ticket cards. */
export function kdsTimerUrgencyTextClass(urgency: KdsTimerUrgency): string {
  switch (urgency) {
    case 'fresh':
      return 'text-emerald-400';
    case 'warning':
      return 'text-amber-400';
    case 'late':
      return 'text-rose-400';
  }
}

/** Left-edge accent on NEW tickets when time is running long. */
export function kdsTimerUrgencyCardAccent(urgency: KdsTimerUrgency): string {
  switch (urgency) {
    case 'fresh':
      return '';
    case 'warning':
      return 'border-l-4 border-l-amber-500';
    case 'late':
      return 'border-l-4 border-l-rose-500';
  }
}

/**
 * When the oldest dish still waiting on a card was sent. Lines added to a
 * card later carry their own time (`kdsFiredAt`); the rest were sent with
 * the card. Once the early lines are done, a card holding only a dish sent
 * a minute ago shows a minute, not the card's age.
 */
export function oldestWaitingFiredAt(
  items: any[],
  ticketFiredAt: string | null,
  opts: { cooker: boolean },
): string | null {
  let oldest: number | null = null;
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.voided || it?.bumped) continue;
    if (opts.cooker && it?.cookerBumped) continue;
    const own = new Date(String(it?.kdsFiredAt || '')).getTime();
    const base = new Date(String(ticketFiredAt || '')).getTime();
    const at = Number.isFinite(own) ? own : base;
    if (!Number.isFinite(at)) continue;
    if (oldest == null || at < oldest) oldest = at;
  }
  return oldest == null ? ticketFiredAt : new Date(oldest).toISOString();
}
