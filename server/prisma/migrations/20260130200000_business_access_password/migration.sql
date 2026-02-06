-- Add provider-supplied tenant access password (hashed).
-- Used to protect public endpoints like /auth/public-users and /shifts/public-open.
ALTER TABLE "Business" ADD COLUMN "accessPasswordHash" TEXT;

