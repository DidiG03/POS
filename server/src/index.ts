import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { env, requireEnv } from './env.js';
import { authMiddleware } from './auth/middleware.js';
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

requireEnv();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: env.corsOrigins.length ? env.corsOrigins : true,
    credentials: false,
  }),
);
app.use(authMiddleware);

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.use('/auth', authRouter);
app.use('/menu', menuRouter);
app.use('/shifts', shiftsRouter);
app.use('/tickets', ticketsRouter);
app.use('/admin', adminRouter);
app.use('/notifications', notificationsRouter);
app.use('/tables', tablesRouter);
app.use('/covers', coversRouter);
app.use('/layout', layoutRouter);
app.use('/requests', requestsRouter);
app.use('/print-jobs', printJobsRouter);
app.use('/reports', reportsRouter);

// Error handler (keeps Cloud Run logs useful)
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('API error', err);
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'invalid request', issues: err.issues });
  }
  if (err && typeof err === 'object' && typeof err.statusCode === 'number') {
    return res.status(err.statusCode).json({ error: err.message || 'error' });
  }
  const msg = typeof err?.message === 'string' ? err.message : 'internal error';
  return res.status(500).json({ error: msg });
});

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`POS server listening on :${env.port}`);
});

