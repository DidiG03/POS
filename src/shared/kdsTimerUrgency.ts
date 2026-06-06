/** Minutes on NEW tickets before the timer turns amber. */
export const KDS_TIMER_WARNING_MINUTES = 10;

/** Minutes on NEW tickets before the timer turns red. */
export const KDS_TIMER_LATE_MINUTES = 20;

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
): KdsTimerUrgency {
  if (elapsedSec >= LATE_SEC) return 'late';
  if (elapsedSec >= WARNING_SEC) return 'warning';
  return 'fresh';
}

export function kdsTimerUrgencyFromIso(
  iso: string,
  nowMs?: number,
): KdsTimerUrgency | null {
  const elapsed = kdsElapsedSeconds(iso, nowMs);
  if (elapsed == null) return null;
  return kdsTimerUrgencyFromElapsed(elapsed);
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
