-- One row per occupied dining table. Concurrent opens of different tables
-- used to read-modify-write a single SyncState JSON blob and lose updates.
CREATE TABLE "TableOccupancy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "area" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "TableOccupancy_area_label_key" ON "TableOccupancy"("area", "label");
CREATE INDEX "TableOccupancy_area_idx" ON "TableOccupancy"("area");
