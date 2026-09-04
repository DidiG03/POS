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
import { sendLicenseKeyEmail } from './sendLicenseEmail.js';

requireEnv();

const stripe = new Stripe(env.stripeSecretKey);

const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing']);

type LicenseEdition = 'RESTAURANT' | 'STORE';

type PlanQuote = {
  amount: number;
  currency: string;
  interval: string;
  formatted: string;
};

type SubInfo = {
  customerId: string;
  email: string;
  status: 'ACTIVE' | 'PAST_DUE' | 'PAUSED';
  periodEnd: string | null;
  subscriptionId: string | null;
  edition: LicenseEdition;
};

const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

function parseEdition(raw: unknown): LicenseEdition | '' {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  return v === 'STORE' || v === 'RESTAURANT' ? v : '';
}

function priceIdForEdition(edition: LicenseEdition): string {
  return edition === 'STORE'
    ? env.stripePriceIdStore
    : env.stripePriceIdRestaurant;
}

function editionFromPriceId(priceId: string): LicenseEdition | '' {
  if (priceId && priceId === env.stripePriceIdStore) return 'STORE';
  if (priceId && priceId === env.stripePriceIdRestaurant) return 'RESTAURANT';
  return '';
}

function priceIdsFromSubscription(sub: Stripe.Subscription): string[] {
  return (sub.items?.data || [])
    .map((item) =>
      typeof item.price === 'string'
        ? item.price
        : String(item.price?.id || ''),
    )
    .filter(Boolean);
}

function editionFromSubscription(sub: Stripe.Subscription): LicenseEdition {
  const fromMeta = parseEdition(sub.metadata?.edition);
  if (fromMeta) return fromMeta;
  const ids = priceIdsFromSubscription(sub);
  for (const id of ids) {
    const edition = editionFromPriceId(id);
    if (edition) return edition;
  }
  // Existing single-price subscribers stay on Restaurant.
  return 'RESTAURANT';
}

function formatStripeAmount(
  unitAmount: number | null | undefined,
  currency: string,
): string {
  const cur = String(currency || 'eur').toLowerCase();
  const amount = Number(unitAmount || 0);
  const major = ZERO_DECIMAL.has(cur) ? amount : amount / 100;
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: cur.toUpperCase(),
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
  }).format(major);
}

function quoteFromPrice(price: Stripe.Price): PlanQuote {
  return {
    amount: Number(price.unit_amount || 0),
    currency: String(price.currency || 'eur'),
    interval: String(price.recurring?.interval || 'month'),
    formatted: formatStripeAmount(price.unit_amount, price.currency),
  };
}

let plansCache: { at: number; restaurant: PlanQuote; store: PlanQuote } | null =
  null;

async function loadPlans(): Promise<{
  restaurant: PlanQuote;
  store: PlanQuote;
}> {
  const now = Date.now();
  if (plansCache && now - plansCache.at < 5 * 60 * 1000) {
    return {
      restaurant: plansCache.restaurant,
      store: plansCache.store,
    };
  }
  const [restaurantPrice, storePrice] = await Promise.all([
    stripe.prices.retrieve(env.stripePriceIdRestaurant),
    stripe.prices.retrieve(env.stripePriceIdStore),
  ]);
  const restaurant = quoteFromPrice(restaurantPrice);
  const store = quoteFromPrice(storePrice);
  plansCache = { at: now, restaurant, store };
  return { restaurant, store };
}

function mapSubStatus(raw: string): SubInfo['status'] {
  const s = raw.toLowerCase();
  if (s === 'active' || s === 'trialing') return 'ACTIVE';
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete')
    return 'PAST_DUE';
  return 'PAUSED';
}

async function subscriptionForCustomer(customerId: string): Promise<{
  status: string;
  periodEnd: number | null;
  id: string;
  edition: LicenseEdition;
} | null> {
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
    edition: editionFromSubscription(preferred),
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
    edition: sub.edition,
    licenseKey: issueLicenseKey(customer.id, email, env.licenseSigningSecret),
  };
}

async function emailKeyIfActive(
  email: string,
): Promise<{ sent: true } | { sent: false; reason: 'none' | 'email' }> {
  const customer = await findCustomerByEmail(email);
  if (!customer) return { sent: false, reason: 'none' };
  const info = await licenseInfoForCustomer(customer, email);
  if (!info || info.status !== 'ACTIVE') return { sent: false, reason: 'none' };
  try {
    await sendLicenseKeyEmail({ to: info.email, licenseKey: info.licenseKey });
    return { sent: true };
  } catch (e) {
    console.error('license email', e);
    return { sent: false, reason: 'email' };
  }
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

app.get('/plans', async (_req, res) => {
  try {
    const plans = await loadPlans();
    return res.status(200).json(plans);
  } catch (e: any) {
    console.error('plans', e);
    return res
      .status(500)
      .json({ error: String(e?.message || 'Could not load plans') });
  }
});

app.post('/checkout/create', async (req, res) => {
  try {
    const email = normalizeLicenseEmail(String(req.body?.email || ''));
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const existing = await findCustomerByEmail(email);
    if (existing) {
      const mailed = await emailKeyIfActive(email);
      if (mailed.sent) {
        return res.status(200).json({
          alreadyLicensed: true,
          emailed: true,
        });
      }
      if (mailed.reason === 'email') {
        return res.status(500).json({
          error: 'Could not email the license key. Try Already a customer.',
        });
      }
    }

    const clip = (v: unknown, n: number) =>
      String(v || '')
        .trim()
        .slice(0, n);
    const edition = parseEdition(req.body?.edition);
    if (!edition) {
      return res
        .status(400)
        .json({ error: 'Choose Restaurant or Store to continue' });
    }
    const name = clip(req.body?.name, 200);
    const phone = clip(req.body?.phone, 40);
    const businessName = clip(req.body?.businessName, 200);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: existing?.id,
      customer_email: existing?.id ? undefined : email,
      line_items: [{ price: priceIdForEdition(edition), quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${env.appBaseUrl}/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appBaseUrl}/return?ok=0`,
      client_reference_id: email.slice(0, 200),
      metadata: {
        email,
        edition,
        ...(name ? { name } : {}),
        ...(phone ? { phone } : {}),
        ...(businessName ? { businessName } : {}),
      },
      subscription_data: {
        metadata: { email, edition },
      },
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
      edition: info.edition,
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
      edition: info.edition,
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
    const emailed = await emailKeyIfActive(email);
    if (emailed.sent) {
      return res.status(200).json({ sent: true });
    }
    if (emailed.reason === 'email') {
      return res.status(500).json({
        error: 'Could not send the license email. Try again.',
      });
    }
    return res.status(200).json({
      sent: false,
      error: 'No active license for that email.',
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
