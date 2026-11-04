/**
 * Circuit breaker for a hanging fiscal service (QA v0.2.104, #12).
 *
 * While easyPos hung, every payment waited the full 20 s request timeout
 * before it was queued. After `FISCAL_BREAKER_TRIP_AFTER` timeouts in a row
 * the breaker opens: new payments are not sent at all, they are queued at
 * once as "not yet fiscalised" (nothing reached easyPos, so nothing can be
 * filed twice) and the background loop sends them later. Any answer from
 * easyPos closes it: a queued invoice the loop sends, or the health probe
 * the loop runs while the breaker is open (`probeFiscalHealthIfOpen`).
 *
 * Only timeouts count. A quick refusal or a 503 is an answer: it does not
 * make anyone wait, and a refusal says the service is up.
 */
export const FISCAL_BREAKER_TRIP_AFTER = 3;
/** Between health probes while open. */
export const FISCAL_BREAKER_PROBE_MS = 30_000;

type State = { timeouts: number; open: boolean; lastProbeAt: number };
const state: State = { timeouts: 0, open: false, lastProbeAt: 0 };
const listeners = new Set<(open: boolean) => void>();

/** A request to easyPos timed out (we stopped waiting). */
export function recordFiscalTimeout(now = Date.now()): void {
  state.timeouts += 1;
  if (!state.open && state.timeouts >= FISCAL_BREAKER_TRIP_AFTER) {
    state.open = true;
    state.lastProbeAt = now;
    console.warn(
      `[fiscal] easyPos timed out ${state.timeouts} times in a row: new sales are queued without waiting until it answers again.`,
    );
    for (const l of listeners) l(true);
  }
}

/** easyPos answered (any HTTP status). */
export function recordFiscalAnswer(): void {
  const wasOpen = state.open;
  state.timeouts = 0;
  state.open = false;
  if (wasOpen) {
    console.warn('[fiscal] easyPos answers again: sales are sent at once.');
    for (const l of listeners) l(false);
  }
}

/** Payments should not wait on easyPos right now. */
export function fiscalBreakerOpen(): boolean {
  return state.open;
}

export function onFiscalBreakerChange(fn: (open: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * While open, ask easyPos whether it answers, at most every
 * `FISCAL_BREAKER_PROBE_MS`. Called from the background loop, never from a
 * payment. `probe` resolves true when easyPos answered.
 */
export async function probeFiscalHealthIfOpen(
  probe: () => Promise<boolean>,
  now = Date.now(),
): Promise<'closed' | 'skipped' | 'healthy' | 'still-down'> {
  if (!state.open) return 'closed';
  if (now - state.lastProbeAt < FISCAL_BREAKER_PROBE_MS) return 'skipped';
  state.lastProbeAt = now;
  const ok = await probe().catch(() => false);
  if (ok) {
    recordFiscalAnswer();
    return 'healthy';
  }
  return 'still-down';
}

/** @internal vitest */
export function __resetFiscalBreakerForTests(): void {
  state.timeouts = 0;
  state.open = false;
  state.lastProbeAt = 0;
  listeners.clear();
}
