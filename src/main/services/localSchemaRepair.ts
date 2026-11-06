/**
 * Last-resort repair of the local database schema at start-up.
 *
 * The migrations (`prisma/migrations`, applied by `runPendingMigrations`
 * before this runs) are the source of truth. This list only re-applies, in
 * an idempotent form, columns, indexes and a table that real migrations
 * already create, for a database whose history and schema disagree (an old
 * install that skipped one, or a migration that failed). A test checks that
 * every object named here exists in a migration, so this list can never
 * become a second schema.
 *
 * Each statement runs on its own: before, the index statements shared one
 * `try` with an empty `catch`, so the first failure silently skipped every
 * index after it. "Already there" errors are expected and stay quiet; any
 * other failure is reported.
 */

export const LOCAL_SCHEMA_REPAIR_STATEMENTS: readonly string[] = [
  `ALTER TABLE "Category" ADD COLUMN "kdsStation" TEXT;`,
  `ALTER TABLE "Category" ADD COLUMN "color" TEXT;`,
  `ALTER TABLE "MenuItem" ADD COLUMN "station" TEXT NOT NULL DEFAULT 'KITCHEN';`,
  `ALTER TABLE "MenuItem" ADD COLUMN "isKg" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "MenuItem" ADD COLUMN "stockLevel" TEXT NOT NULL DEFAULT 'OK';`,
  `ALTER TABLE "MenuItem" ADD COLUMN "stockRemaining" INTEGER;`,
  `ALTER TABLE "MenuItem" ADD COLUMN "stockDay" TEXT;`,
  `ALTER TABLE "MenuItem" ADD COLUMN "costPrice" DECIMAL;`,
  `ALTER TABLE "MenuItem" ADD COLUMN "costBreakdown" JSONB;`,
  `ALTER TABLE "Reservation" ADD COLUMN "externalSource" TEXT;`,
  `ALTER TABLE "Reservation" ADD COLUMN "externalId" TEXT;`,
  `ALTER TABLE "TicketLog" ADD COLUMN "sessionKey" TEXT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Reservation_externalSource_externalId_key" ON "Reservation"("externalSource", "externalId");`,
  `CREATE INDEX IF NOT EXISTS "TicketLog_sessionKey_idx" ON "TicketLog"("sessionKey");`,
  `CREATE INDEX IF NOT EXISTS "TicketLog_userId_createdAt_idx" ON "TicketLog"("userId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "TicketLog_createdAt_idx" ON "TicketLog"("createdAt");`,
  `CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification"("createdAt");`,
  `CREATE INDEX IF NOT EXISTS "DayShift_closedAt_openedById_idx" ON "DayShift"("closedAt", "openedById");`,
  `CREATE INDEX IF NOT EXISTS "TicketRequest_ownerId_status_idx" ON "TicketRequest"("ownerId", "status");`,
  `CREATE INDEX IF NOT EXISTS "Covers_createdAt_idx" ON "Covers"("createdAt");`,
  `CREATE INDEX IF NOT EXISTS "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");`,
  `CREATE INDEX IF NOT EXISTS "Modifier_groupId_idx" ON "Modifier"("groupId");`,
  `CREATE INDEX IF NOT EXISTS "RecipeComponent_menuItemId_idx" ON "RecipeComponent"("menuItemId");`,
  `CREATE INDEX IF NOT EXISTS "RecipeComponent_inventoryItemId_idx" ON "RecipeComponent"("inventoryItemId");`,
  `CREATE INDEX IF NOT EXISTS "OrderItem_menuItemId_idx" ON "OrderItem"("menuItemId");`,
  `CREATE INDEX IF NOT EXISTS "OrderItemModifier_orderItemId_idx" ON "OrderItemModifier"("orderItemId");`,
  `CREATE INDEX IF NOT EXISTS "OrderItemModifier_modifierId_idx" ON "OrderItemModifier"("modifierId");`,
  `CREATE INDEX IF NOT EXISTS "Order_status_closedAt_idx" ON "Order"("status", "closedAt");`,
  `CREATE INDEX IF NOT EXISTS "TicketRequest_requesterId_idx" ON "TicketRequest"("requesterId");`,
  `CREATE TABLE IF NOT EXISTS "TableOccupancy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "area" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TableOccupancy_area_label_key" ON "TableOccupancy"("area", "label");`,
  `CREATE INDEX IF NOT EXISTS "TableOccupancy_area_idx" ON "TableOccupancy"("area");`,
];

/** SQLite's answer when the column / index / table is already in place. */
export function isAlreadyAppliedError(e: unknown): boolean {
  const msg = String((e as any)?.message || e || '').toLowerCase();
  return (
    msg.includes('duplicate column name') || msg.includes('already exists')
  );
}

export async function repairLocalSchema(
  exec: (sql: string) => Promise<unknown>,
  onFailure: (sql: string, error: unknown) => void = (sql, error) =>
    console.warn('[startup] schema repair statement failed:', sql, error),
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const sql of LOCAL_SCHEMA_REPAIR_STATEMENTS) {
    try {
      await exec(sql);
      applied += 1;
    } catch (e) {
      if (isAlreadyAppliedError(e)) continue;
      failed += 1;
      onFailure(sql, e);
    }
  }
  return { applied, failed };
}
