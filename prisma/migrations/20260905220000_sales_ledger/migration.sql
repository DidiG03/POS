-- Redefine Order / OrderItem / Payment into a queryable sales ledger.
-- Existing rows (historically unused) are copied; PAYMENT PrintJobs are
-- backfilled in application code on host boot.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "tableId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "userId" INTEGER,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "area" TEXT NOT NULL DEFAULT '',
    "tableLabel" TEXT NOT NULL DEFAULT '',
    "covers" INTEGER,
    "note" TEXT,
    "userName" TEXT,
    "idempotencyKey" TEXT,
    "printJobId" INTEGER,
    "seatId" TEXT,
    "seatLabel" TEXT,
    "subtotal" DECIMAL NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL NOT NULL DEFAULT 0,
    "discountType" TEXT,
    "discountReason" TEXT,
    "serviceChargeAmount" DECIMAL NOT NULL DEFAULT 0,
    "total" DECIMAL NOT NULL DEFAULT 0,
    "vatEnabled" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_printJobId_fkey" FOREIGN KEY ("printJobId") REFERENCES "PrintJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Order" ("id", "type", "tableId", "status", "userId", "openedAt", "closedAt")
SELECT "id", "type", "tableId", "status", "userId", "openedAt", "closedAt" FROM "Order";

DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";

CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
CREATE UNIQUE INDEX "Order_printJobId_key" ON "Order"("printJobId");
CREATE INDEX "Order_userId_closedAt_idx" ON "Order"("userId", "closedAt");
CREATE INDEX "Order_area_tableLabel_closedAt_idx" ON "Order"("area", "tableLabel", "closedAt");
CREATE INDEX "Order_closedAt_idx" ON "Order"("closedAt");

CREATE TABLE "new_OrderItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "menuItemId" INTEGER,
    "sku" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "unitPrice" DECIMAL NOT NULL,
    "vatRate" DECIMAL NOT NULL,
    "note" TEXT,
    "station" TEXT,
    "categoryName" TEXT,
    "courseId" TEXT,
    "seatId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_OrderItem" ("id", "orderId", "menuItemId", "qty", "unitPrice", "vatRate", "note", "name")
SELECT "id", "orderId", "menuItemId", "qty", "unitPrice", "vatRate", "note", 'Item' FROM "OrderItem";

DROP TABLE "OrderItem";
ALTER TABLE "new_OrderItem" RENAME TO "OrderItem";

CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX "OrderItem_sku_idx" ON "OrderItem"("sku");

CREATE TABLE "new_Payment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "tip" DECIMAL NOT NULL DEFAULT 0,
    "change" DECIMAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "idempotencyKey" TEXT,
    "fiscalNslf" TEXT,
    "fiscalNivf" TEXT,
    "metaJson" JSONB NOT NULL,
    CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Payment" ("id", "orderId", "method", "amount", "tip", "change", "createdAt", "metaJson")
SELECT "id", "orderId", "method", "amount", "tip", "change", "createdAt", "metaJson" FROM "Payment";

DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";

CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
CREATE INDEX "Payment_paidAt_idx" ON "Payment"("paidAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
