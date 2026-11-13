/**
 * Carry on after an error, but say so in the log.
 *
 * `promise.catch(() => null)` kept a payment, a print or a fiscal step
 * going when a side write failed, which is right, but left no trace: a
 * missing receipt row or an unsent invoice could not be explained later.
 * `promise.catch(logIgnored('where', null))` answers the same fallback and
 * writes one warning line to the log file (`appLog.ts`).
 */
export function logIgnored<T>(where: string, fallback: T): (e: unknown) => T {
  return (e: unknown) => {
    const err = e as { code?: unknown; message?: unknown } | null;
    const code = err?.code ? ` [${String(err.code)}]` : '';
    const message = String(err?.message ?? e);
    console.warn(`[ignored] ${where}${code}: ${message}`);
    return fallback;
  };
}
