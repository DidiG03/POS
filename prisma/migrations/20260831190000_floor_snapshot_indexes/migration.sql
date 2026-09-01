-- CreateIndex
CREATE INDEX "Covers_area_label_createdAt_idx" ON "Covers"("area", "label", "createdAt");

-- CreateIndex
CREATE INDEX "TicketLog_area_tableLabel_createdAt_idx" ON "TicketLog"("area", "tableLabel", "createdAt");
