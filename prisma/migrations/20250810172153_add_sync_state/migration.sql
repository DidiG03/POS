-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "valueJson" JSONB,
    "updatedAt" DATETIME NOT NULL
);
