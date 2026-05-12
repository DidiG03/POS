-- Printer-offline retry queue (PR 3).
-- Adds attempt tracking + scheduling fields to PrintJob so that prints
-- which fail with a transient network error (printer briefly unplugged,
-- Wi-Fi blip) can be picked back up by the printer-station loop and
-- retried automatically. The new RETRY enum value is enforced at the
-- application layer (Prisma stores enums as TEXT on SQLite).

ALTER TABLE "PrintJob" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PrintJob" ADD COLUMN "lastError" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "PrintJob" ADD COLUMN "printerProfileId" TEXT;

-- The loop's hot query is "find me the next batch of RETRY rows whose
-- nextAttemptAt has passed", so pre-index that pair.
CREATE INDEX "PrintJob_status_nextAttemptAt_idx" ON "PrintJob"("status", "nextAttemptAt");
