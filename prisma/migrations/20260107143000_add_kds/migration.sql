-- KDS: stations + per-day order number + per-station ticket bumping

-- Add station routing to menu items
ALTER TABLE "MenuItem" ADD COLUMN "station" TEXT NOT NULL DEFAULT 'KITCHEN';

-- Per-day counter for order numbers
CREATE TABLE "KdsDayCounter" (
    "dayKey" TEXT NOT NULL PRIMARY KEY,
    "lastNo" INTEGER NOT NULL DEFAULT 0
);

-- Orders (order number resets per dayKey)
CREATE TABLE "KdsOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dayKey" TEXT NOT NULL,
    "orderNo" INTEGER NOT NULL,
    "area" TEXT NOT NULL,
    "tableLabel" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME
);

CREATE UNIQUE INDEX "KdsOrder_dayKey_orderNo_key" ON "KdsOrder"("dayKey", "orderNo");
CREATE INDEX "KdsOrder_area_tableLabel_closedAt_idx" ON "KdsOrder"("area", "tableLabel", "closedAt");

-- Tickets ("fires") created each time staff presses Send
CREATE TABLE "KdsTicket" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" INTEGER NOT NULL,
    "userId" INTEGER,
    "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemsJson" JSONB NOT NULL,
    "note" TEXT,
    CONSTRAINT "KdsTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "KdsOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "KdsTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "KdsTicket_orderId_firedAt_idx" ON "KdsTicket"("orderId", "firedAt");

-- Per-station status: NEW -> DONE
CREATE TABLE "KdsTicketStation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ticketId" INTEGER NOT NULL,
    "station" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "bumpedAt" DATETIME,
    "bumpedById" INTEGER,
    CONSTRAINT "KdsTicketStation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KdsTicket" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "KdsTicketStation_bumpedById_fkey" FOREIGN KEY ("bumpedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "KdsTicketStation_ticketId_station_key" ON "KdsTicketStation"("ticketId", "station");
CREATE INDEX "KdsTicketStation_station_status_bumpedAt_idx" ON "KdsTicketStation"("station", "status", "bumpedAt");

