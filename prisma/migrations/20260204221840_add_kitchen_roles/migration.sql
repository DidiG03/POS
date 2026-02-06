-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KdsTicket" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "userId" INTEGER,
    "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemsJson" JSONB NOT NULL,
    "note" TEXT,
    CONSTRAINT "KdsTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "KdsOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_KdsTicket" ("firedAt", "id", "itemsJson", "note", "orderId", "userId") SELECT "firedAt", "id", "itemsJson", "note", "orderId", "userId" FROM "KdsTicket";
DROP TABLE "KdsTicket";
ALTER TABLE "new_KdsTicket" RENAME TO "KdsTicket";
CREATE INDEX "KdsTicket_orderId_firedAt_idx" ON "KdsTicket"("orderId", "firedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
