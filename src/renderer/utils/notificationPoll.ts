/**
 * How often the notification badge asks the till.
 *
 * It polled every 20 s on every phone because nothing announced new
 * notifications. A till that sends live `notifications` events says so in
 * its SSE ping (`browserLanApi.ts` sets `__POS_SSE_FEATURES__`); then the
 * badge refreshes on the event and keeps only a slow safety poll.
 */
export const NOTIFICATION_SLOW_POLL_MS = 60_000;

export function notificationPollIsSlow(): boolean {
  try {
    return Boolean((window as any).__POS_SSE_FEATURES__?.notifications);
  } catch {
    return false;
  }
}
