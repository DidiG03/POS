/**
 * Bound how long an I/O promise may take.
 *
 * The print pipeline is a single queue: one job runs at a time and the next
 * only starts when the previous settles. Anything that can hang forever
 * therefore stops every receipt on the terminal, not just its own. A USB
 * adapter whose cable was pulled will happily accept an open and never
 * complete the write, and a paused CUPS queue never returns from `lp`, so
 * every step that touches hardware needs a deadline.
 */

export class OperationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Reject with {@link OperationTimeoutError} if `promise` has not settled within
 * `timeoutMs`. A non-positive or non-finite timeout disables the deadline.
 *
 * The underlying work is not cancelled — that is up to the caller, which knows
 * how to close the socket or kill the child process. The point here is that the
 * queue gets control back.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'Operation',
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OperationTimeoutError(label, timeoutMs));
    }, timeoutMs);
    // Never hold the process open just to enforce a deadline.
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
