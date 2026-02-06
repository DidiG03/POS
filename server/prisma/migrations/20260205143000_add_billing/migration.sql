-- Billing: Stripe customer/subscription + status gate

DO $$
BEGIN
  CREATE TYPE "BillingStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'PAUSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "billingStatus" "BillingStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "billingUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "billingPeriodEnd" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "billingPausedAt" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Business_stripeCustomerId_key" ON "Business"("stripeCustomerId");
CREATE UNIQUE INDEX IF NOT EXISTS "Business_stripeSubscriptionId_key" ON "Business"("stripeSubscriptionId");

