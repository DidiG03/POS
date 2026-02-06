import dotenv from 'dotenv';

dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || '',
  billingEnabled: String(process.env.BILLING_ENABLED || '').toLowerCase() === 'true' || String(process.env.BILLING_ENABLED || '') === '1',
  appBaseUrl: (process.env.APP_BASE_URL || '').trim().replace(/\/+$/g, ''),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePriceId: process.env.STRIPE_PRICE_ID || '',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export function requireEnv() {
  const missing: string[] = [];
  if (!env.databaseUrl) missing.push('DATABASE_URL');
  if (!env.jwtSecret || env.jwtSecret.length < 32) missing.push('JWT_SECRET (>= 32 chars)');
  if (env.billingEnabled) {
    if (!env.appBaseUrl) missing.push('APP_BASE_URL (required when BILLING_ENABLED=1)');
    if (!env.stripeSecretKey) missing.push('STRIPE_SECRET_KEY (required when BILLING_ENABLED=1)');
    if (!env.stripeWebhookSecret) missing.push('STRIPE_WEBHOOK_SECRET (required when BILLING_ENABLED=1)');
    if (!env.stripePriceId) missing.push('STRIPE_PRICE_ID (required when BILLING_ENABLED=1)');
  }
  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(', ')}`);
  }
}

