-- Add business active flag for tenant disable

ALTER TABLE "Business" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

