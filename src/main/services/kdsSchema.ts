import { prisma } from '@db/client';

let __kdsSchemaReady: boolean | null = null;

/** Best-effort self-healing for local KDS tables (shared by IPC + LAN API). */
export async function ensureKdsLocalSchema(): Promise<boolean> {
  if (__kdsSchemaReady === true) return true;
  try {
    await (prisma as any).kdsDayCounter.count();
    __kdsSchemaReady = true;
    return true;
  } catch {
    // continue
  }
  try {
    try {
      await (prisma as any).$executeRawUnsafe(
        `ALTER TABLE "MenuItem" ADD COLUMN "station" TEXT NOT NULL DEFAULT 'KITCHEN';`,
      );
    } catch {
      // ignore
    }
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsDayCounter" ("dayKey" TEXT NOT NULL PRIMARY KEY, "lastNo" INTEGER NOT NULL DEFAULT 0);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsOrder" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "dayKey" TEXT NOT NULL, "orderNo" INTEGER NOT NULL, "area" TEXT NOT NULL, "tableLabel" TEXT NOT NULL, "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "closedAt" DATETIME);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "KdsOrder_dayKey_orderNo_key" ON "KdsOrder"("dayKey","orderNo");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsOrder_area_tableLabel_closedAt_idx" ON "KdsOrder"("area","tableLabel","closedAt");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsTicket" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "orderId" INTEGER NOT NULL, "userId" INTEGER, "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "itemsJson" JSONB NOT NULL, "note" TEXT, CONSTRAINT "KdsTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "KdsOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "KdsTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsTicket_orderId_firedAt_idx" ON "KdsTicket"("orderId","firedAt");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "KdsTicketStation" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "ticketId" INTEGER NOT NULL, "station" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'NEW', "bumpedAt" DATETIME, "bumpedById" INTEGER, CONSTRAINT "KdsTicketStation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KdsTicket" ("id") ON DELETE RESTRICT ON UPDATE CASCADE, CONSTRAINT "KdsTicketStation_bumpedById_fkey" FOREIGN KEY ("bumpedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE);`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "KdsTicketStation_ticketId_station_key" ON "KdsTicketStation"("ticketId","station");`,
    );
    await (prisma as any).$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "KdsTicketStation_station_status_bumpedAt_idx" ON "KdsTicketStation"("station","status","bumpedAt");`,
    );
    __kdsSchemaReady = true;
    return true;
  } catch {
    __kdsSchemaReady = false;
    return false;
  }
}
