import { Router } from 'express';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const billingRouter = Router();

// Any authenticated user can read billing status (used by POS "gate").
billingRouter.get('/status', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const biz = await prisma.business.findUnique({ where: { id: auth.businessId } }).catch(() => null);
  if (!biz) return res.status(404).json({ error: 'not found' });
  const statusRaw = String((biz as any).billingStatus || 'ACTIVE').toUpperCase();
  const hasSub = Boolean(String((biz as any).stripeSubscriptionId || '').trim());
  // If billing is enabled but there's no subscription yet, treat as paused until payment happens.
  const effective = env.billingEnabled && !hasSub ? 'PAUSED' : statusRaw;
  return res.status(200).json({
    billingEnabled: env.billingEnabled,
    status: effective === 'PAST_DUE' || effective === 'PAUSED' ? effective : 'ACTIVE',
    currentPeriodEnd: (biz as any).billingPeriodEnd ? (biz as any).billingPeriodEnd.toISOString() : null,
  });
});

// A tiny hosted page Stripe can redirect to after checkout (works even if APP_BASE_URL is the API domain).
billingRouter.get('/return', async (req, res) => {
  const ok = String((req.query as any)?.ok || '').trim() === '1';
  const title = ok ? 'Payment successful' : 'Payment cancelled';
  const body = ok
    ? 'Thanks — your POS access will unlock automatically in a few seconds. You can now return to the app.'
    : 'No payment was completed. Please return to the app and try again.';
  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0b1220; color: #e5e7eb; margin: 0; padding: 24px; }
      .card { max-width: 720px; margin: 0 auto; background: #111827; border: 1px solid #374151; border-radius: 12px; padding: 20px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { margin: 0; opacity: 0.9; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${body}</p>
    </div>
  </body>
</html>`);
});

