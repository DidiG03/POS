/**
 * Billing-only API: Stripe Checkout + license keys.
 * No Postgres. Stripe is the source of truth; keys are HMAC of customer id.
 */
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { env, requireEnv } from './env.js';
import {
  issueLicenseKey,
  normalizeLicenseEmail,
  parseLicenseKey,
} from './licenseKey.js';

requireEnv();

const stripe = new Stripe(env.stripeSecretKey);

const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);

type SubInfo = {
  customerId: string;
  email: string;
  status: 'ACTIVE' | 'PAST_DUE' | 'PAUSED';
  periodEnd: string | null;
  subscriptionId: string | null;
};

function mapSubStatus(raw: string): SubInfo['status'] {
  const s = raw.toLowerCase();
  if (s === 'active' || s === 'trialing') return 'ACTIVE';
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete')
    return 'PAST_DUE';
  return 'PAUSED';
}

async function subscriptionForCustomer(
  customerId: string,
): Promise<{ status: string; periodEnd: number | null; id: string } | null> {
  const list = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
  });
  const preferred =
    list.data.find((s) => ACTIVE_SUB_STATUSES.has(String(s.status))) ||
    list.data.find((s) => String(s.status) === 'past_due') ||
    list.data[0] ||
    null;
  if (!preferred) return null;
  const periodEnd = Number((preferred as any).current_period_end || 0);
  return {
    status: String(preferred.status || ''),
    periodEnd: periodEnd > 0 ? periodEnd : null,
    id: preferred.id,
  };
}

async function findCustomerByEmail(
  email: string,
): Promise<Stripe.Customer | null> {
  const list = await stripe.customers.list({ email, limit: 10 });
  return list.data[0] || null;
}

async function licenseInfoForCustomer(
  customer: Stripe.Customer,
  emailFallback: string,
): Promise<(SubInfo & { licenseKey: string }) | null> {
  const email = normalizeLicenseEmail(customer.email || emailFallback || '');
  if (!email) return null;
  const sub = await subscriptionForCustomer(customer.id);
  if (!sub) return null;
  const status = mapSubStatus(sub.status);
  return {
    customerId: customer.id,
    email,
    status,
    periodEnd: sub.periodEnd
      ? new Date(sub.periodEnd * 1000).toISOString()
      : null,
    subscriptionId: sub.id,
    licenseKey: issueLicenseKey(customer.id, email, env.licenseSigningSecret),
  };
}

const restoreHits = new Map<string, { count: number; resetAt: number }>();
function allowRestore(ip: string): boolean {
  const now = Date.now();
  const cur = restoreHits.get(ip);
  if (!cur || cur.resetAt <= now) {
    restoreHits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (cur.count >= 8) return false;
  cur.count += 1;
  return true;
}

const app = express();
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json', limit: '2mb' }),
  (req, res) => {
    if (!env.stripeWebhookSecret) {
      return res.status(200).json({ ok: true, ignored: true });
    }
    const sig = String(req.headers['stripe-signature'] || '');
    try {
      stripe.webhooks.constructEvent(req.body, sig, env.stripeWebhookSecret);
    } catch {
      return res.status(400).json({ error: 'invalid signature' });
    }
    // No local DB to update — the POS redeems Checkout session ids / keys
    // against Stripe on demand.
    return res.status(200).json({ ok: true });
  },
);

app.use(express.json({ limit: '32kb' }));
app.use(
  cors({
    origin:
      env.corsOrigins.length > 0
        ? env.corsOrigins
        : env.nodeEnv === 'production'
          ? false
          : true,
  }),
);

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.post('/checkout/create', async (req, res) => {
  try {
    const email = normalizeLicenseEmail(String(req.body?.email || ''));
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const existing = await findCustomerByEmail(email);
    if (existing) {
      const info = await licenseInfoForCustomer(existing, email);
      if (info && info.status === 'ACTIVE') {
        return res.status(200).json({
          alreadyLicensed: true,
          licenseKey: info.licenseKey,
          email: info.email,
          status: info.status,
          currentPeriodEnd: info.periodEnd,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: existing?.id,
      customer_email: existing?.id ? undefined : email,
      line_items: [{ price: env.stripePriceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${env.appBaseUrl}/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appBaseUrl}/return?ok=0`,
      client_reference_id: email.slice(0, 200),
      metadata: { email },
    });
    return res.status(200).json({ url: session.url, alreadyLicensed: false });
  } catch (e: any) {
    console.error('checkout/create', e);
    return res
      .status(500)
      .json({ error: String(e?.message || 'Could not start checkout') });
  }
});

app.post('/license/activate-session', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'Invalid checkout session' });
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer'],
    });
    const paid =
      session.status === 'complete' ||
      session.payment_status === 'paid' ||
      session.payment_status === 'no_payment_required';
    if (!paid) {
      return res.status(402).json({ error: 'Payment not completed' });
    }
    const customer =
      typeof session.customer === 'object' && session.customer
        ? (session.customer as Stripe.Customer)
        : session.customer
          ? await stripe.customers.retrieve(String(session.customer))
          : null;
    if (!customer || customer.deleted) {
      return res.status(400).json({ error: 'No customer on session' });
    }
    const email = normalizeLicenseEmail(
      customer.email ||
        session.customer_details?.email ||
        session.customer_email ||
        '',
    );
    const info = await licenseInfoForCustomer(
      customer as Stripe.Customer,
      email,
    );
    if (!info) {
      return res.status(402).json({ error: 'No active subscription yet' });
    }
    return res.status(200).json({
      licenseKey: info.licenseKey,
      email: info.email,
      status: info.status,
      currentPeriodEnd: info.periodEnd,
    });
  } catch (e: any) {
    console.error('license/activate-session', e);
    return res
      .status(500)
      .json({ error: String(e?.message || 'Could not activate license') });
  }
});

app.post('/license/validate', async (req, res) => {
  try {
    const parsed = parseLicenseKey(
      String(req.body?.key || ''),
      env.licenseSigningSecret,
    );
    if (!parsed) return res.status(400).json({ error: 'Invalid license key' });
    const customer = await stripe.customers.retrieve(parsed.cid);
    if (!customer || (customer as Stripe.DeletedCustomer).deleted) {
      return res.status(404).json({ error: 'License not found' });
    }
    const info = await licenseInfoForCustomer(
      customer as Stripe.Customer,
      parsed.em,
    );
    if (!info) {
      return res.status(200).json({
        valid: false,
        status: 'PAUSED' as const,
        email: parsed.em,
      });
    }
    return res.status(200).json({
      valid: info.status === 'ACTIVE',
      status: info.status,
      email: info.email,
      currentPeriodEnd: info.periodEnd,
      licenseKey: info.licenseKey,
    });
  } catch (e: any) {
    console.error('license/validate', e);
    return res
      .status(500)
      .json({ error: String(e?.message || 'Could not validate license') });
  }
});

app.post('/license/restore', async (req, res) => {
  const ip = String(
    req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
  )
    .split(',')[0]
    .trim();
  if (!allowRestore(ip || 'unknown')) {
    return res.status(429).json({ error: 'Too many restore attempts' });
  }
  try {
    const email = normalizeLicenseEmail(String(req.body?.email || ''));
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const customer = await findCustomerByEmail(email);
    if (!customer) {
      // Same message as no-sub to avoid email enumeration.
      return res.status(200).json({
        found: false,
        message: 'If this email has an active subscription, the key is below.',
      });
    }
    const info = await licenseInfoForCustomer(customer, email);
    if (!info || info.status !== 'ACTIVE') {
      return res.status(200).json({
        found: false,
        message: 'If this email has an active subscription, the key is below.',
      });
    }
    return res.status(200).json({
      found: true,
      licenseKey: info.licenseKey,
      email: info.email,
      status: info.status,
      currentPeriodEnd: info.periodEnd,
    });
  } catch (e: any) {
    console.error('license/restore', e);
    return res
      .status(500)
      .json({ error: String(e?.message || 'Could not restore license') });
  }
});

app.post('/license/portal', async (req, res) => {
  try {
    const parsed = parseLicenseKey(
      String(req.body?.key || ''),
      env.licenseSigningSecret,
    );
    if (!parsed) return res.status(400).json({ error: 'Invalid license key' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: parsed.cid,
      return_url: `${env.appBaseUrl}/return`,
    });
    return res.status(200).json({ url: portal.url });
  } catch (e: any) {
    console.error('license/portal', e);
    return res
      .status(500)
      .json({ error: String(e?.message || 'Could not open billing portal') });
  }
});

app.get('/return', (req, res) => {
  const sessionId = String(req.query.session_id || '').trim();
  const ok = String(req.query.ok || '').trim() !== '0';
  const deep = sessionId
    ? `codeorbit-pos://activate?session_id=${encodeURIComponent(sessionId)}`
    : '';
  const title = ok && sessionId ? 'Payment received' : 'Returned from Stripe';
  const body =
    ok && sessionId
      ? 'Return to OneTap POS. If the app does not open, it will pick up this payment automatically — or paste your email under “I already paid”.'
      : 'No payment was completed. You can close this tab and try again in the app.';
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8')
    .send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; background:#0b1220; color:#e5e7eb; margin:0; padding:24px; }
      .card { max-width:640px; margin:0 auto; background:#111827; border:1px solid #374151; border-radius:12px; padding:20px; }
      a { color:#93c5fd; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${body}</p>
      ${
        deep
          ? `<p><a href="${deep}">Open OneTap POS</a></p>
<script>location.href=${JSON.stringify(deep)};</script>`
          : ''
      }
    </div>
  </body>
</html>`);
});

export default app;

if (!process.env.VERCEL) {
  app.listen(env.port, () => {
    console.log(`POS billing listening on :${env.port}`);
  });
}
