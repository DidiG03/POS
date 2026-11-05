-- The latest bill, covers and paid orders of a table are read newest-id
-- first on every Send, payment and floor paint. The existing indexes end in
-- createdAt/closedAt, so SQLite sorted the table's whole history each time
-- (TEMP B-TREE), about 60 ms per read at 20,000 rows (audit 2026-11, H1).
CREATE INDEX IF NOT EXISTS "TicketLog_area_tableLabel_id_idx" ON "TicketLog"("area", "tableLabel", "id");
CREATE INDEX IF NOT EXISTS "Covers_area_label_id_idx" ON "Covers"("area", "label", "id");
CREATE INDEX IF NOT EXISTS "Order_area_tableLabel_status_id_idx" ON "Order"("area", "tableLabel", "status", "id");
