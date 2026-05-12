import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { env, requireEnv } from './env.js';
import { authMiddleware } from './auth/middleware.js';
import { isClockOnlyRole } from './auth/roles.js';
import { prisma } from './db.js';
import { authRouter } from './routes/auth.js';
import { menuRouter } from './routes/menu.js';
import { shiftsRouter } from './routes/shifts.js';
import { ticketsRouter } from './routes/tickets.js';
import { adminRouter } from './routes/admin.js';
import { notificationsRouter } from './routes/notifications.js';
import { tablesRouter } from './routes/tables.js';
import { coversRouter } from './routes/covers.js';
import { layoutRouter } from './routes/layout.js';
import { requestsRouter } from './routes/requests.js';
import { printJobsRouter } from './routes/printJobs.js';
import { reportsRouter } from './routes/reports.js';
import { billingRouter } from './routes/billing.js';
import { stripeWebhookHandler } from './routes/stripeWebhook.js';
import { backupsRouter } from './routes/backups.js';

requireEnv();

const app = express();
// Stripe webhook needs RAW body (must be registered before express.json).
app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '2mb' }), stripeWebhookHandler);
app.use(express.json({ limit: '2mb' }));

// CORS: in production, refuse to fall back to a permissive allow-all.
// In development we still allow `true` to make local tooling easier.
if (!env.corsOrigins.length && env.nodeEnv === 'production') {
  console.warn(
    '[security] CORS_ORIGINS is empty in production — refusing to enable cross-origin requests.',
  );
}
app.use(
  cors({
    origin:
      env.corsOrigins.length > 0
        ? env.corsOrigins
        : env.nodeEnv === 'production'
          ? false
          : true,
    credentials: false,
  }),
);
app.use(authMiddleware);

// Enforce "clock-only" roles (KP/CHEF/HEAD_CHEF): they may only use /shifts and /auth endpoints.
app.use((req, res, next) => {
  const auth = (req as any).auth;
  if (auth && isClockOnlyRole(auth.role)) {
    const p = String((req as any).path || '');
    if (!p.startsWith('/shifts') && !p.startsWith('/auth')) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  return next();
});

// Billing gate: when enabled and business is unpaid, block POS routes (but still allow auth + billing routes).
app.use(async (req, res, next) => {
  if (!env.billingEnabled) return next();
  const auth = (req as any).auth;
  if (!auth?.businessId) return next();
  const p = String((req as any).path || '');
  // Always allow auth, billing, admin, and shifts (so staff can still clock in/out even when POS is paused).
  if (
    p === '/health' ||
    p.startsWith('/auth') ||
    p.startsWith('/billing') ||
    p.startsWith('/admin') ||
    p.startsWith('/shifts') ||
    p.startsWith('/stripe/webhook')
  ) {
    return next();
  }
  try {
    const biz = await prisma.business.findUnique({ where: { id: auth.businessId } }).catch(() => null as any);
    const st = String((biz as any)?.billingStatus || 'ACTIVE').toUpperCase();
    // Critical: require an actual subscription per business.
    // Otherwise new tenants (default billingStatus=ACTIVE) would incorrectly be treated as "paid".
    const hasSub = Boolean(String((biz as any)?.stripeSubscriptionId || '').trim());
    const paused = !hasSub || st === 'PAST_DUE' || st === 'PAUSED';
    if (paused) {
      return res.status(402).json({
        error: 'billing_required',
        status: !hasSub ? 'PAUSED' : (st === 'PAST_DUE' ? 'PAST_DUE' : 'PAUSED'),
      });
    }
  } catch {
    // If billing check fails (DB), don't hard-lock everything; allow request through.
  }
  return next();
});

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.use('/auth', authRouter);
app.use('/menu', menuRouter);
app.use('/shifts', shiftsRouter);
app.use('/tickets', ticketsRouter);
app.use('/admin', adminRouter);
app.use('/billing', billingRouter);
app.use('/notifications', notificationsRouter);
app.use('/tables', tablesRouter);
app.use('/covers', coversRouter);
app.use('/layout', layoutRouter);
app.use('/requests', requestsRouter);
app.use('/print-jobs', printJobsRouter);
app.use('/reports', reportsRouter);
app.use('/backups', backupsRouter);

// Error handler (keeps Cloud Run logs useful but doesn't leak internals to clients)
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API error', err);
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'invalid request', issues: err.issues });
  }
  if (err && typeof err === 'object' && typeof err.statusCode === 'number') {
    // 4xx errors are typically safe to surface (the message is intentional).
    if (err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message || 'error' });
    }
  }
  // Never leak internal error messages (Prisma stack traces, SQL hints, file paths, etc.)
  // The full error is logged above; clients only get a generic message.
  return res.status(500).json({ error: 'internal error' });
});

app.listen(env.port, () => {
  console.log(`POS server listening on :${env.port}`);
});

