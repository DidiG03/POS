-- SQLite: daily menu stock reset uses stockDay vs local date on the host.
ALTER TABLE "MenuItem" ADD COLUMN "stockRemaining" INTEGER;
ALTER TABLE "MenuItem" ADD COLUMN "stockDay" TEXT;
