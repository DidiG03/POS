-- Link menu categories to a KDS prep station (null = not shown on KDS).
ALTER TABLE "Category" ADD COLUMN "kdsStation" TEXT;

UPDATE "Category"
SET "kdsStation" = 'KITCHEN'
WHERE lower(trim(name)) IN (
  'food',
  'starters',
  'mains',
  'sides',
  'salads',
  'breakfast',
  'desserts'
);

UPDATE "Category"
SET "kdsStation" = 'BAR'
WHERE lower(trim(name)) IN (
  'drinks',
  'hot drinks',
  'soft drinks',
  'alcohol',
  'beverages'
);

UPDATE "Category"
SET "kdsStation" = 'KITCHEN'
WHERE "kdsStation" IS NULL
  AND lower(trim(name)) LIKE '%food%';

UPDATE "Category"
SET "kdsStation" = 'BAR'
WHERE "kdsStation" IS NULL
  AND (
    lower(trim(name)) LIKE '%drink%'
    OR lower(trim(name)) LIKE '%beverage%'
  );
