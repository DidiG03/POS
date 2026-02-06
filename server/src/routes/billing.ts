import { Router } from 'express';
import Stripe from 'stripe';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const billingRouter = Router();

function stripeClient() {
  if (!env.stripeSecretKey) throw new Error('Stripe not configured');
  return new Stripe(env.stripeSecretKey, { apiVersion: '2025-01-27.acacia' } as any);
}

function mapStripeSubscriptionStatus(sub: any): 'ACTIVE' | 'PAST_DUE' | 'PAUSED' {
  const s = String(sub?.status || '').toLowerCase();
  if (s === 'active' || s === 'trialing') return 'ACTIVE';
  if (s === 'past_due') return 'PAST_DUE';
  if (s === 'canceled' || s === 'unpaid' || s === 'incomplete_expired') return 'PAUSED';
  // incomplete / paused / other => treat as past due to be safe
  return 'PAST_DUE';
}

// Any authenticated user can read billing status (used by POS "gate").
billingRouter.get('/status', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  // Optional live refresh from Stripe (admin-only, best-effort).
  // This makes "canceled at period end" show immediately even if a webhook was missed.
  const wantLive = String((req.query as any)?.live || '').trim() === '1';
  if (wantLive && env.billingEnabled && auth.role === 'ADMIN') {
    try {
      const biz0: any = await prisma.business.findUnique({ where: { id: auth.businessId } }).catch(() => null);
      const subId = String(biz0?.stripeSubscriptionId || '').trim();
      if (subId && env.stripeSecretKey) {
        const stripe = stripeClient();
        const sub = await stripe.subscriptions.retrieve(subId as any).catch(() => null as any);
        if (sub) {
          const nextStatus = mapStripeSubscriptionStatus(sub);
          const periodEnd = Number((sub as any)?.current_period_end || 0);
          const cancelAtPeriodEnd = Boolean((sub as any)?.cancel_at_period_end);
          const cancelAt = Number((sub as any)?.cancel_at || 0);
          const canceledAt = Number((sub as any)?.canceled_at || 0);
          const now = new Date();
          await prisma.business
            .updateMany({
              where: { id: auth.businessId },
              data: {
                billingStatus: nextStatus as any,
                billingUpdatedAt: now,
                billingPeriodEnd: periodEnd > 0 ? new Date(periodEnd * 1000) : null,
                billingCancelAt: cancelAtPeriodEnd && cancelAt > 0 ? new Date(cancelAt * 1000) : null,
                billingCancelRequestedAt: cancelAtPeriodEnd ? (canceledAt > 0 ? new Date(canceledAt * 1000) : now) : null,
                billingPausedAt: nextStatus === 'PAUSED' ? now : null,
              } as any,
            })
            .catch(() => null);
        }
      }
    } catch {
      // ignore live refresh failures
    }
  }

  const biz = await prisma.business.findUnique({ where: { id: auth.businessId } }).catch(() => null);
  if (!biz) return res.status(404).json({ error: 'not found' });
  const statusRaw = String((biz as any).billingStatus || 'ACTIVE').toUpperCase();
  const hasSub = Boolean(String((biz as any).stripeSubscriptionId || '').trim());
  // If billing is enabled but there's no subscription yet, treat as paused until payment happens.
  const effective = env.billingEnabled && !hasSub ? 'PAUSED' : statusRaw;
  const cancelAtIso = (biz as any).billingCancelAt ? (biz as any).billingCancelAt.toISOString() : null;
  const cancelRequestedAtIso = (biz as any).billingCancelRequestedAt ? (biz as any).billingCancelRequestedAt.toISOString() : null;
  const pausedAtIso = (biz as any).billingPausedAt ? (biz as any).billingPausedAt.toISOString() : null;
  const periodEndIso = (biz as any).billingPeriodEnd ? (biz as any).billingPeriodEnd.toISOString() : null;
  const isActive = !(effective === 'PAST_DUE' || effective === 'PAUSED');
  const cancellationScheduled = isActive && Boolean(cancelAtIso);
  const cancelled = !hasSub && Boolean(pausedAtIso || cancelRequestedAtIso);

  let message: string | null = null;
  if (env.billingEnabled) {
    if (cancelled) message = 'Subscription canceled. POS access is paused until you subscribe again.';
    else if (cancellationScheduled && cancelAtIso) message = `Subscription will cancel at period end (${new Date(cancelAtIso).toLocaleString()}).`;
  }
  return res.status(200).json({
    billingEnabled: env.billingEnabled,
    status: effective === 'PAST_DUE' || effective === 'PAUSED' ? effective : 'ACTIVE',
    currentPeriodEnd: periodEndIso,
    cancelAt: cancelAtIso,
    cancelRequestedAt: cancelRequestedAtIso,
    pausedAt: pausedAtIso,
    message,
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

