-- Admin/report queries that still table-scanned on the 1.3 MB till.
-- TicketLog userId/createdAt indexes shipped in 20260916194500.

CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
CREATE INDEX "DayShift_closedAt_openedById_idx" ON "DayShift"("closedAt", "openedById");
CREATE INDEX "TicketRequest_ownerId_status_idx" ON "TicketRequest"("ownerId", "status");
CREATE INDEX "Covers_createdAt_idx" ON "Covers"("createdAt");
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");
