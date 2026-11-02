/**
 * Cold start with the till unreachable: keep trying in the background.
 *
 * The boot screen used to try twice and then stop on "Cannot reach POS
 * backend" for good. When the till came back the phone stayed there (its
 * queued order still went through, from the offline queue) until someone
 * opened the scan dialog (QA v0.2.103). It now probes the configured till
 * with backoff, and right away when the phone comes back online or to the
 * foreground, and boots again on the first answer.
 */

/** 2 s, 4 s, 8 s, then every 15 s. */
export function bootRetryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(15_000, 2_000 * 2 ** Math.min(n, 3));
}

/**
 * Probe until `probe` resolves, then call `onBack` once. Returns a stop
 * function. `probe` rejecting means the till is still unreachable.
 */
export function watchForBackend(input: {
  probe: () => Promise<unknown>;
  onBack: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called with a "try now" function; return an unsubscribe. */
  subscribeWake?: (wake: () => void) => () => void;
}): () => void {
  const setT =
    input.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT =
    input.clearTimer ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let stopped = false;
  let inFlight = false;
  let attempt = 0;
  let timer: unknown = null;
  const schedule = () => {
    if (stopped) return;
    timer = setT(() => void tryNow(), bootRetryDelayMs(attempt++));
  };
  const tryNow = async () => {
    if (stopped || inFlight) return;
    if (timer != null) clearT(timer);
    timer = null;
    inFlight = true;
    try {
      await input.probe();
      if (stopped) return;
      stopped = true;
      unsubscribe();
      input.onBack();
    } catch {
      schedule();
    } finally {
      inFlight = false;
    }
  };
  const unsubscribe = input.subscribeWake?.(() => void tryNow()) ?? (() => {});
  schedule();
  return () => {
    stopped = true;
    if (timer != null) clearT(timer);
    unsubscribe();
  };
}
