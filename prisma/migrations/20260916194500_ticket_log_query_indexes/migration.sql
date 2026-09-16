-- Waiter reports filter TicketLog by userId + createdAt; void counts
-- and admin date ranges filter by createdAt alone.
CREATE INDEX "TicketLog_userId_createdAt_idx" ON "TicketLog"("userId", "createdAt");
CREATE INDEX "TicketLog_createdAt_idx" ON "TicketLog"("createdAt");
