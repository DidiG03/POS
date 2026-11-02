/**
 * Queue an invoice whose send ended with an unknown outcome (a 5xx other
 * than 503, a timeout, a dropped connection): easyPos may or may not have
 * filed it.
 *
 * Shared by the payment path and the deferred-transmit loop. The invoice is
 * never sent again blind:
 *   - cloud API: `checkStatusFirst` makes the next send ask /invoice/status
 *     and file only when easyPos has never seen the docId, so the queue
 *     drains on its own after an outage;
 *   - local middleware: it has no status route, so the invoice is held for a
 *     person to check easyPos first (QA v0.2.103, H2).
 */
import type { SettingsDTO } from '@shared/ipc';
import { backoffDelayMs } from './backoff';
import { commitDeferredFiscalClaim } from './claims';
import { fiscalConfig } from './config';

/** Null when the queue write did not stick; `held` when it waits for a person. */
export async function deferUnconfirmed(input: {
  docId: string;
  attemptId: string;
  message: string;
  draft: unknown;
  settings: SettingsDTO;
  attempts: number;
  now?: number;
}): Promise<{ held: boolean; reason: string } | null> {
  const cloud = fiscalConfig(input.settings).cloud;
  const reason = cloud
    ? input.message
    : `easyPos did not confirm docId ${input.docId} (${input.message}). It may already be filed, and the local easyPos middleware cannot be asked. Check this docId in easyPos, then choose "Found in easyPos" or "Not in easyPos — send again".`;
  const queued = await commitDeferredFiscalClaim(
    input.docId,
    input.attemptId,
    input.message,
    JSON.parse(JSON.stringify(input.draft)),
    new Date(
      (input.now ?? Date.now()) + backoffDelayMs(Math.max(1, input.attempts)),
    ).toISOString(),
    { checkStatusFirst: true, ...(cloud ? {} : { holdReason: reason }) },
  );
  return queued ? { held: !cloud, reason } : null;
}
