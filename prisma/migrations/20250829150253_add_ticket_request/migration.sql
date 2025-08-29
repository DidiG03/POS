-- CreateTable
CREATE TABLE "TicketRequest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "area" TEXT NOT NULL,
    "tableLabel" TEXT NOT NULL,
    "requesterId" INTEGER NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "itemsJson" JSONB NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    CONSTRAINT "TicketRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TicketRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
