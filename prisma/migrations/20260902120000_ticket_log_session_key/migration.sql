-- AlterTable
ALTER TABLE "TicketLog" ADD COLUMN "sessionKey" TEXT;

-- CreateIndex
CREATE INDEX "TicketLog_sessionKey_idx" ON "TicketLog"("sessionKey");
