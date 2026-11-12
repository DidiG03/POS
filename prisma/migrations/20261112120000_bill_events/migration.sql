-- What was taken off a bill, by whom and on whose approval: voids,
-- discounts, a service charge removed, a price corrected. These were only
-- kept as notifications, which are deleted after a week. One row per
-- event, never edited and never pruned.
CREATE TABLE IF NOT EXISTS "BillEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "area" TEXT NOT NULL DEFAULT '',
    "tableLabel" TEXT NOT NULL DEFAULT '',
    "actorUserId" INTEGER,
    "actorName" TEXT,
    "approvedById" INTEGER,
    "approverName" TEXT,
    "amount" DECIMAL,
    "reason" TEXT,
    "source" TEXT,
    "detailsJson" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "BillEvent_createdAt_idx" ON "BillEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "BillEvent_kind_createdAt_idx" ON "BillEvent"("kind", "createdAt");
CREATE INDEX IF NOT EXISTS "BillEvent_actorUserId_createdAt_idx" ON "BillEvent"("actorUserId", "createdAt");
