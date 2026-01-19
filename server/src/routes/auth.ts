import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { issueToken } from '../auth/jwt.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const authRouter = Router();

function normalizeBusinessCode(input: string) {
  return input.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

// Basic in-memory rate limit for login attempts (per IP)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function allowLoginAttempt(remoteIp: string, maxPerWindow = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const cur = loginAttempts.get(remoteIp);
  if (!cur || cur.resetAt <= now) {
    loginAttempts.set(remoteIp, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (cur.count >= maxPerWindow) return false;
  cur.count += 1;
  loginAttempts.set(remoteIp, cur);
  return true;
}

const RegisterBusinessSchema = z.object({
  businessName: z.string().min(2).max(80),
  businessCode: z.string().min(2).max(24).optional(),
  adminName: z.string().min(1).max(80),
  adminPin: z.string().min(4).max(6).regex(/^\d+$/),
  adminEmail: z.string().email().optional(),
});

authRouter.post('/register-business', async (req, res) => {
  const input = RegisterBusinessSchema.parse(req.body || {});
  const businessCode = normalizeBusinessCode(input.businessCode || input.businessName);
  if (businessCode.length < 2) return res.status(400).json({ error: 'invalid businessCode' });

  const existing = await prisma.business.findUnique({ where: { code: businessCode } });
  if (existing) return res.status(409).json({ error: 'businessCode already exists' });

  const pinHash = await bcrypt.hash(input.adminPin, 10);
  const created = await prisma.business.create({
    data: {
      name: input.businessName.trim(),
      code: businessCode,
      active: true,
      users: {
        create: {
          displayName: input.adminName.trim(),
          role: 'ADMIN',
          pinHash,
          active: true,
          ...(input.adminEmail ? { email: input.adminEmail.toLowerCase() } : {}),
        },
      },
    },
    include: { users: true },
  });

  const admin = created.users[0]!;
  const token = issueToken({ businessId: created.id, userId: admin.id, role: admin.role as any });
  return res.status(201).json({
    business: { id: created.id, name: created.name, code: created.code, createdAt: created.createdAt.toISOString() },
    user: { id: admin.id, displayName: admin.displayName, role: admin.role, active: admin.active, createdAt: admin.createdAt.toISOString() },
    token,
  });
});

const LoginPinSchema = z.object({
  businessCode: z.string().min(2).max(24),
  pin: z.string().min(4).max(6).regex(/^\d+$/),
  userId: z.number().int().positive().optional(),
});

const VerifyManagerPinSchema = z.object({
  businessCode: z.string().min(2).max(24),
  pin: z.string().min(4).max(6).regex(/^\d+$/),
});

// Verify a manager/admin PIN without issuing a session token.
// Used for approvals (discounts/voids) on waiter devices.
authRouter.post('/verify-manager-pin', async (req, res) => {
  const remoteIp = String((req.headers['x-forwarded-for'] as any) || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowLoginAttempt(remoteIp)) return res.status(429).json({ error: 'too many attempts' });
  const input = VerifyManagerPinSchema.parse(req.body || {});
  const businessCode = normalizeBusinessCode(input.businessCode);
  const biz = await prisma.business.findUnique({ where: { code: businessCode } });
  if (!biz || (biz as any).active === false) return res.status(200).json({ ok: false });

  const admins = await prisma.user.findMany({
    where: { businessId: biz.id, active: true, role: 'ADMIN' },
    orderBy: { id: 'asc' },
    take: 50,
  });
  for (const u of admins) {
    const ok = await bcrypt.compare(String(input.pin), u.pinHash);
    if (ok) {
      return res.status(200).json({ ok: true, userId: u.id, userName: u.displayName });
    }
  }
  return res.status(200).json({ ok: false });
});

// Main login endpoint (PIN-based, consistent with existing POS UX)
authRouter.post('/login', async (req, res) => {
  const remoteIp = String((req.headers['x-forwarded-for'] as any) || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowLoginAttempt(remoteIp)) return res.status(429).json({ error: 'too many attempts' });
  const input = LoginPinSchema.parse(req.body || {});
  const businessCode = normalizeBusinessCode(input.businessCode);
  const biz = await prisma.business.findUnique({ where: { code: businessCode } });
  if (!biz || (biz as any).active === false) return res.status(200).json(null);

  const where: any = { businessId: biz.id, active: true };
  if (input.userId) where.id = input.userId;
  const user = await prisma.user.findFirst({ where });
  if (!user) return res.status(200).json(null);

  const ok = await bcrypt.compare(String(input.pin), user.pinHash);
  if (!ok) return res.status(200).json(null);

  const token = issueToken({ businessId: biz.id, userId: user.id, role: user.role as any });
  return res.status(200).json({
    user: { id: user.id, displayName: user.displayName, role: user.role, active: user.active, createdAt: user.createdAt.toISOString() },
    token,
  });
});

// Public staff list for login screen (no token required)
// Returns active users only; PIN hashes are never exposed.
authRouter.get('/public-users', async (req, res) => {
  const businessCode = normalizeBusinessCode(String(req.query.businessCode || ''));
  if (!businessCode) return res.status(400).json({ error: 'businessCode required' });
  const includeAdmins = String(req.query.includeAdmins || '') === '1';
  const biz = await prisma.business.findUnique({ where: { code: businessCode } });
  if (!biz || (biz as any).active === false) return res.status(200).json([]);
  const where: any = { businessId: biz.id, active: true };
  if (!includeAdmins) where.role = { not: 'ADMIN' };
  const users = await prisma.user.findMany({ where, orderBy: { id: 'asc' } });
  return res.status(200).json(users.map((u) => ({ id: u.id, displayName: u.displayName, role: u.role, active: u.active, createdAt: u.createdAt.toISOString() })));
});

// Compatibility alias
authRouter.post('/login-pin', async (req, res) => {
  req.url = '/login';
  return (authRouter as any).handle(req, res);
});

authRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const user = await prisma.user.findFirst({ where: { id: auth.userId, businessId: auth.businessId } });
  if (!user) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ id: user.id, displayName: user.displayName, role: user.role, active: user.active, createdAt: user.createdAt.toISOString() });
});

// Staff management (admin only)
const CreateUserSchema = z.object({
  displayName: z.string().min(1).max(80),
  role: z.enum(['ADMIN', 'CASHIER', 'WAITER']),
  pin: z.string().min(4).max(6).regex(/^\d+$/),
  active: z.boolean().optional().default(true),
  email: z.string().email().optional(),
});

authRouter.get('/users', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  if (auth.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
  const users = await prisma.user.findMany({ where: { businessId: auth.businessId }, orderBy: { id: 'asc' } });
  return res.status(200).json(users.map((u) => ({ id: u.id, displayName: u.displayName, role: u.role, active: u.active, createdAt: u.createdAt.toISOString() })));
});

authRouter.post('/users', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  if (auth.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
  const input = CreateUserSchema.parse(req.body || {});
  const pinHash = await bcrypt.hash(input.pin, 10);
  const created = await prisma.user.create({
    data: {
      businessId: auth.businessId,
      displayName: input.displayName.trim(),
      role: input.role,
      pinHash,
      active: input.active ?? true,
      ...(input.email ? { email: input.email.toLowerCase() } : {}),
    },
  });
  return res.status(201).json({ id: created.id, displayName: created.displayName, role: created.role, active: created.active, createdAt: created.createdAt.toISOString() });
});

const UpdateUserSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  role: z.enum(['ADMIN', 'CASHIER', 'WAITER']).optional(),
  pin: z.string().min(4).max(6).regex(/^\d+$/).optional(),
  active: z.boolean().optional(),
  email: z.string().email().optional(),
});

authRouter.put('/users/:id', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  if (auth.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const input = UpdateUserSchema.parse(req.body || {});
  if (id === auth.userId && input.active === false) return res.status(400).json({ error: 'cannot disable yourself' });
  let pinHash: string | undefined;
  if (input.pin) pinHash = await bcrypt.hash(input.pin, 10);
  await prisma.user.updateMany({
    where: { id, businessId: auth.businessId },
    data: {
      ...(input.displayName ? { displayName: input.displayName.trim() } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
      ...(typeof input.email === 'string' ? { email: input.email.toLowerCase() } : {}),
      ...(pinHash ? { pinHash } : {}),
    },
  });
  const updated = await prisma.user.findFirst({ where: { id, businessId: auth.businessId } });
  if (!updated) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ id: updated.id, displayName: updated.displayName, role: updated.role, active: updated.active, createdAt: updated.createdAt.toISOString() });
});

authRouter.delete('/users/:id', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  if (auth.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  if (id === auth.userId) return res.status(400).json({ error: 'cannot delete yourself' });
  await prisma.user.updateMany({ where: { id, businessId: auth.businessId }, data: { active: false } });
  return res.status(200).json(true);
});

