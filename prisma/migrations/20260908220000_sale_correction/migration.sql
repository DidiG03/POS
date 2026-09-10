-- Admin reversal of a settled sale.
--
-- A fiscalized invoice is already with the tax service and cannot be
-- withdrawn, so a reversal is a second document referencing the first.
-- These columns record what was reversed and hold the link to that
-- document; `filedAt` stays NULL until it exists.
--
-- Additive only: no table is rebuilt, so existing sales are untouched.

ALTER TABLE "Order" ADD COLUMN "voidedAt" DATETIME;
ALTER TABLE "OrderItem" ADD COLUMN "voidedAt" DATETIME;

CREATE TABLE "SaleCorrection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amountDelta" DECIMAL NOT NULL DEFAULT 0,
    "itemsJson" JSONB,
    "actorUserId" INTEGER,
    "approvedById" INTEGER,
    "originalNslf" TEXT,
    "originalNivf" TEXT,
    "correctionNslf" TEXT,
    "correctionNivf" TEXT,
    "filedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaleCorrection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SaleCorrection_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SaleCorrection_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "SaleCorrection_orderId_idx" ON "SaleCorrection"("orderId");
CREATE INDEX "SaleCorrection_createdAt_idx" ON "SaleCorrection"("createdAt");
CREATE INDEX "SaleCorrection_filedAt_idx" ON "SaleCorrection"("filedAt");
