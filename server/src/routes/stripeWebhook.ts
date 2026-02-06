import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { env } from '../env.js';
import { prisma } from '../db.js';

function stripeClient() {
  if (!env.stripeSecretKey) throw new Error('Stripe not configured');
  return new Stripe(env.stripeSecretKey, { apiVersion: '2025-01-27.acacia' } as any);
}

function normalizeStatus(s: string): 'ACTIVE' | 'PAST_DUE' | 'PAUSED' {
  const u = String(s || '').toUpperCase();
  if (u === 'PAST_DUE' || u === 'PAUSED') return u as any;
  return 'ACTIVE';
}

async function setBusinessBillingByCustomer(customerId: string, next: { status?: string; subscriptionId?: string | null; periodEnd?: number | null; pausedAt?: number | null }) {
  if (!customerId) return;
  const data: any = {};
  if (next.status) data.billingStatus = normalizeStatus(next.status);
  data.billingUpdatedAt = new Date();
  if (next.subscriptionId !== undefined) data.stripeSubscriptionId = next.subscriptionId;
  if (next.periodEnd !== undefined) data.billingPeriodEnd = next.periodEnd ? new Date(next.periodEnd * 1000) : null;
  if (next.pausedAt !== undefined) data.billingPausedAt = next.pausedAt ? new Date(next.pausedAt * 1000) : null;
  await prisma.business.updateMany({ where: { stripeCustomerId: customerId }, data }).catch(() => null);
}

export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!env.billingEnabled) return res.status(200).json({ ok: true });
  if (!env.stripeWebhookSecret) return res.status(500).json({ error: 'missing STRIPE_WEBHOOK_SECRET' });

  const sig = String(req.headers['stripe-signature'] || '');
  const raw = req.body; // must be express.raw()
  const stripe = stripeClient();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, env.stripeWebhookSecret);
  } catch (err: any) {
    return res.status(400).json({ error: `invalid signature: ${String(err?.message || err)}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const customerId = typeof s.customer === 'string' ? s.customer : '';
        const subscriptionId = typeof s.subscription === 'string' ? s.subscription : null;
        // Mark active immediately; periodEnd will be filled by subscription events or invoice events.
        await setBusinessBillingByCustomer(customerId, { status: 'ACTIVE', subscriptionId, pausedAt: null });
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === 'string' ? inv.customer : '';
        await setBusinessBillingByCustomer(customerId, { status: 'PAST_DUE' });
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === 'string' ? inv.customer : '';
        // invoice.lines periods are the safest hint without extra API calls
        const line = inv.lines?.data?.[0];
        const periodEnd = line?.period?.end ?? null;
        await setBusinessBillingByCustomer(customerId, { status: 'ACTIVE', periodEnd, pausedAt: null });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : '';
        const status = sub.status === 'active' || sub.status === 'trialing' ? 'ACTIVE' : sub.status === 'past_due' ? 'PAST_DUE' : 'PAST_DUE';
        // Cancellation warning (best-effort): if the customer canceled but it's still active until period end,
        // we keep billing ACTIVE but store cancelAt/cancelRequestedAt so the UI can show a warning.
        const cancelAtPeriodEnd = Boolean((sub as any)?.cancel_at_period_end);
        const cancelAt = Number((sub as any)?.cancel_at || 0);
        const canceledAt = Number((sub as any)?.canceled_at || 0);

        // Stripe's generated TS types in this repo don't expose subscription.current_period_end,
        // but subscription items do expose current_period_end. Use the max item period end as best-effort.
        let periodEnd: number | null = null;
        try {
          const items = (sub as any)?.items?.data;
          if (Array.isArray(items) && items.length) {
            const ends = items
              .map((it: any) => Number(it?.current_period_end || 0))
              .filter((n: number) => Number.isFinite(n) && n > 0);
            if (ends.length) periodEnd = Math.max(...ends);
          }
        } catch {
          periodEnd = null;
        }
        await setBusinessBillingByCustomer(customerId, {
          status,
          subscriptionId: sub.id,
          periodEnd,
        });
        // Update cancellation fields (separate update to keep helper small and flexible)
        try {
          await prisma.business.updateMany({
            where: { stripeCustomerId: customerId },
            data: {
              billingCancelAt: cancelAtPeriodEnd && cancelAt > 0 ? new Date(cancelAt * 1000) : null,
              billingCancelRequestedAt: cancelAtPeriodEnd
                ? (canceledAt > 0 ? new Date(canceledAt * 1000) : new Date())
                : null,
            } as any,
          });
        } catch {
          // ignore
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : '';
        await setBusinessBillingByCustomer(customerId, { status: 'PAUSED', subscriptionId: null, periodEnd: null, pausedAt: Math.floor(Date.now() / 1000) });
        // Mark cancellation timestamp for UI warning/history.
        try {
          const now = new Date();
          await prisma.business.updateMany({
            where: { stripeCustomerId: customerId },
            data: {
              billingCancelAt: now,
              billingCancelRequestedAt: now,
            } as any,
          });
        } catch {
          // ignore
        }
        break;
      }
      default:
        break;
    }
  } catch {
    // don't retry forever; Stripe will retry webhooks on 5xx
    return res.status(500).json({ error: 'webhook handler failed' });
  }

  return res.status(200).json({ received: true });
}

