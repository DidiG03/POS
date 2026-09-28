/**
 * "Erase tickets" high-water mark.
 *
 * Erasing deletes Order / Payment rows but deliberately keeps PrintJob rows:
 * their idempotency keys are what stop a tablet replaying a queued payment
 * from printing and fiscalizing it a second time. Those same rows are the
 * source the boot backfill rebuilds missing sales from, so without a marker
 * every erased sale came back on the next restart.
 *
 * The erase records the newest PrintJob id at that moment. Anything at or
 * below it belongs to the erased ledger: backfill and retry repair skip it,
 * and print-job retention may purge it on its normal schedule.
 */

export const LEDGER_ERASED_THROUGH_KEY = 'salesLedger:erasedThroughPrintJobId';

type SyncStateReader = {
  syncState?: {
    findUnique: (args: any) => Promise<{ valueJson?: unknown } | null>;
  };
};

/** Newest PrintJob id covered by an erase, or 0 when nothing was erased. */
export async function readLedgerErasedThroughId(
  client: SyncStateReader,
): Promise<number> {
  if (!client?.syncState?.findUnique) return 0;
  const row = await client.syncState
    .findUnique({ where: { key: LEDGER_ERASED_THROUGH_KEY } })
    .catch(() => null);
  const id = Number((row?.valueJson as any)?.printJobId || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

/** True when this PrintJob predates the last erase. */
export function printJobWasErased(
  printJobId: unknown,
  erasedThroughId: number,
): boolean {
  const id = Number(printJobId);
  return erasedThroughId > 0 && Number.isInteger(id) && id <= erasedThroughId;
}

/**
 * When the last "Erase tickets" ran, or null. Fiscal claims older than this
 * belong to sales that were erased on purpose, so they must not be reported
 * as invoices with no recorded sale.
 */
export async function readLedgerErasedAt(
  client: SyncStateReader,
): Promise<Date | null> {
  if (!client?.syncState?.findUnique) return null;
  const row = await client.syncState
    .findUnique({ where: { key: LEDGER_ERASED_THROUGH_KEY } })
    .catch(() => null);
  const at = Date.parse(String((row?.valueJson as any)?.erasedAt || ''));
  return Number.isFinite(at) ? new Date(at) : null;
}
