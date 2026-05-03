-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MenuItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "price" DECIMAL NOT NULL,
    "vatRate" DECIMAL NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isKg" BOOLEAN NOT NULL DEFAULT false,
    "station" TEXT NOT NULL DEFAULT 'KITCHEN',
    CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_MenuItem" ("active", "categoryId", "id", "name", "price", "sku", "station", "vatRate") SELECT "active", "categoryId", "id", "name", "price", "sku", "station", "vatRate" FROM "MenuItem";
DROP TABLE "MenuItem";
ALTER TABLE "new_MenuItem" RENAME TO "MenuItem";
CREATE UNIQUE INDEX "MenuItem_sku_key" ON "MenuItem"("sku");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
