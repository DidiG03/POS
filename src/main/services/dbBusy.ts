/** When a request last failed because the ledger was busy (status lights). */
let lastBusyAt: string | null = null;
export function noteDatabaseBusy(at = new Date()): void {
  lastBusyAt = at.toISOString();
}
export function lastDatabaseBusyAt(): string | null {
  return lastBusyAt;
}
