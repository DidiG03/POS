import dotenv from 'dotenv';

dotenv.config();

function required(name: string, value: string, min = 1): string {
  const v = value.trim();
  if (v.length < min) {
    throw new Error(`Missing env: ${name}`);
  }
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),
  stripeSecretKey: String(process.env.STRIPE_SECRET_KEY || '').trim(),
  stripeWebhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
  stripePriceId: String(process.env.STRIPE_PRICE_ID || '').trim(),
  licenseSigningSecret: String(process.env.LICENSE_SIGNING_SECRET || '').trim(),
  appBaseUrl: String(process.env.APP_BASE_URL || '')
    .trim()
    .replace(/\/+$/g, ''),
  corsOrigins: String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export function requireEnv() {
  required('STRIPE_SECRET_KEY', env.stripeSecretKey, 8);
  required('STRIPE_PRICE_ID', env.stripePriceId, 4);
  required('LICENSE_SIGNING_SECRET', env.licenseSigningSecret, 16);
  required('APP_BASE_URL', env.appBaseUrl, 8);
}
