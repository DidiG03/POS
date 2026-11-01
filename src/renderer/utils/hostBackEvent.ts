/**
 * "The till answers again" (QA round 6, #7).
 *
 * A phone that started while the till was unreachable showed "No table
 * areas configured" and an empty menu, and stayed that way after the till
 * came back until the waiter switched tabs: the floor and the menu only
 * reloaded on focus. The heartbeat (`AppLayout.tsx`) fires this event on
 * the first answer after a failure; screens reload what they show on it.
 */
export const POS_HOST_BACK = 'pos:hostBack';

/** True when this answer ends a stretch of failed checks (or a failed start). */
export function hostCameBack(input: {
  hadFailure: boolean;
  ok: boolean;
}): boolean {
  return input.ok && input.hadFailure;
}

export function announceHostBack(): void {
  try {
    window.dispatchEvent(new Event(POS_HOST_BACK));
  } catch {
    // ignore
  }
}
