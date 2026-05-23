-- AlterTable: waiter-facing stock signal (Admin Menu → waiter tiles)
ALTER TABLE "MenuItem" ADD COLUMN "stockLevel" TEXT NOT NULL DEFAULT 'OK';
