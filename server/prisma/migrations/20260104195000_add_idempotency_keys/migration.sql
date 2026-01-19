-- Add optional idempotency keys for safe retries (offline sync, printing)

ALTER TABLE "TicketLog" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "idempotencyKey" TEXT;

-- Postgres allows multiple NULLs in UNIQUE constraints, so this works for optional keys.
CREATE UNIQUE INDEX "TicketLog_businessId_idempotencyKey_key" ON "TicketLog"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "PrintJob_businessId_idempotencyKey_key" ON "PrintJob"("businessId", "idempotencyKey");

