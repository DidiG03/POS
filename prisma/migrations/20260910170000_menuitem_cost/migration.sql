-- Store inventory: unit cost and optional cost split (purchase, packaging, …).
ALTER TABLE "MenuItem" ADD COLUMN "costPrice" DECIMAL;
ALTER TABLE "MenuItem" ADD COLUMN "costBreakdown" JSONB;
