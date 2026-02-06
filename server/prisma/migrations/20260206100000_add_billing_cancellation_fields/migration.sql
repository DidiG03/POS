-- Billing: surface Stripe cancellation warnings in UI

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "billingCancelAt" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "billingCancelRequestedAt" TIMESTAMP(3);

