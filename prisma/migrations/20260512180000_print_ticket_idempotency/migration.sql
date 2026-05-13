-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "TicketLog" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_idempotencyKey_key" ON "PrintJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLog_idempotencyKey_key" ON "TicketLog"("idempotencyKey");
