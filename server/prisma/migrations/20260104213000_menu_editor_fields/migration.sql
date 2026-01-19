-- Menu editor: category color + per-item isKg flag (replaces syncState mapping)

ALTER TABLE "Category" ADD COLUMN "color" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN "isKg" BOOLEAN NOT NULL DEFAULT false;

