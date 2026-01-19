-- KDS: stations + per-day order number + per-station ticket bumping

-- Enums
DO $$ BEGIN
  CREATE TYPE "PrepStation" AS ENUM ('KITCHEN', 'BAR', 'DESSERT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "KdsStationStatus" AS ENUM ('NEW', 'DONE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Add station routing to menu items
ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "station" "PrepStation" NOT NULL DEFAULT 'KITCHEN';

-- Per-day counter for order numbers (per business)
CREATE TABLE IF NOT EXISTS "KdsDayCounter" (
  "id" SERIAL PRIMARY KEY,
  "businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "dayKey" TEXT NOT NULL,
  "lastNo" INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "KdsDayCounter_businessId_dayKey_key" ON "KdsDayCounter"("businessId", "dayKey");
CREATE INDEX IF NOT EXISTS "KdsDayCounter_businessId_idx" ON "KdsDayCounter"("businessId");

-- Orders (order number resets per dayKey)
CREATE TABLE IF NOT EXISTS "KdsOrder" (
  "id" SERIAL PRIMARY KEY,
  "businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "dayKey" TEXT NOT NULL,
  "orderNo" INTEGER NOT NULL,
  "area" TEXT NOT NULL,
  "tableLabel" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "KdsOrder_businessId_dayKey_orderNo_key" ON "KdsOrder"("businessId", "dayKey", "orderNo");
CREATE INDEX IF NOT EXISTS "KdsOrder_businessId_idx" ON "KdsOrder"("businessId");
CREATE INDEX IF NOT EXISTS "KdsOrder_businessId_area_tableLabel_closedAt_idx" ON "KdsOrder"("businessId", "area", "tableLabel", "closedAt");

-- Tickets ("fires") created each time staff presses Send
CREATE TABLE IF NOT EXISTS "KdsTicket" (
  "id" SERIAL PRIMARY KEY,
  "businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "orderId" INTEGER NOT NULL REFERENCES "KdsOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "userId" INTEGER,
  "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "itemsJson" JSONB NOT NULL,
  "note" TEXT
);

CREATE INDEX IF NOT EXISTS "KdsTicket_businessId_idx" ON "KdsTicket"("businessId");
CREATE INDEX IF NOT EXISTS "KdsTicket_businessId_orderId_firedAt_idx" ON "KdsTicket"("businessId", "orderId", "firedAt");

-- Per-station status: NEW -> DONE
CREATE TABLE IF NOT EXISTS "KdsTicketStation" (
  "id" SERIAL PRIMARY KEY,
  "businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "ticketId" INTEGER NOT NULL REFERENCES "KdsTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "station" "PrepStation" NOT NULL,
  "status" "KdsStationStatus" NOT NULL DEFAULT 'NEW',
  "bumpedAt" TIMESTAMP(3),
  "bumpedById" INTEGER REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "KdsTicketStation_businessId_ticketId_station_key" ON "KdsTicketStation"("businessId", "ticketId", "station");
CREATE INDEX IF NOT EXISTS "KdsTicketStation_businessId_idx" ON "KdsTicketStation"("businessId");
CREATE INDEX IF NOT EXISTS "KdsTicketStation_businessId_station_status_bumpedAt_idx" ON "KdsTicketStation"("businessId", "station", "status", "bumpedAt");

