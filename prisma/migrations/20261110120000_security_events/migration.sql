-- Security events (failed sign-ins, refused requests, ledger erasure) were
-- only kept in memory and were gone when the till restarted. One row per
-- event, read newest first in Admin and pruned by age.
CREATE TABLE IF NOT EXISTS "SecurityEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event" TEXT NOT NULL,
    "detailsJson" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");
