import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const menuRouter = Router();

function requireAdmin(req: AuthedRequest) {
  const auth = req.auth!;
  if (auth.role !== 'ADMIN') return null;
  return auth;
}

menuRouter.get('/categories', requireAuth, async (req: AuthedRequest, res) => {
  const auth = req.auth!;
  const cats = await prisma.category.findMany({
    where: { businessId: auth.businessId, active: true },
    orderBy: { sortOrder: 'asc' },
    // Include inactive items too so admins can re-enable; waiters will render disabled items greyed out.
    include: { items: { orderBy: { name: 'asc' } } },
  });
  return res.status(200).json(
    cats.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      active: c.active,
      color: (c as any).color ?? null,
      items: c.items.map((i) => ({
        id: i.id,
        name: i.name,
        sku: i.sku,
        price: Number(i.price),
        vatRate: Number(i.vatRate),
        active: i.active,
        categoryId: i.categoryId,
        isKg: Boolean((i as any).isKg),
      })),
    })),
  );
});

const CreateCategorySchema = z.object({
  name: z.string().min(1).max(80),
  sortOrder: z.number().int().min(0).max(9999).optional().default(0),
  color: z.string().max(24).optional().nullable(), // hex or any css token
  active: z.boolean().optional().default(true),
});

menuRouter.post('/categories', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  if (!auth) return res.status(403).json({ error: 'forbidden' });
  const input = CreateCategorySchema.parse(req.body || {});
  const created = await prisma.category.create({
    data: {
      businessId: auth.businessId,
      name: input.name.trim(),
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
      color: input.color ?? null,
    } as any,
  });
  return res.status(201).json({ id: created.id });
});

const UpdateCategorySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  color: z.string().max(24).optional().nullable(),
  active: z.boolean().optional(),
});

menuRouter.put('/categories/:id', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  if (!auth) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const input = UpdateCategorySchema.parse(req.body || {});
  const updated = await prisma.category.updateMany({
    where: { businessId: auth.businessId, id },
    data: {
      ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
      ...(typeof input.sortOrder === 'number' ? { sortOrder: input.sortOrder } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
    } as any,
  });
  if (!updated.count) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
});

menuRouter.delete('/categories/:id', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  if (!auth) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  await prisma.category.updateMany({ where: { businessId: auth.businessId, id }, data: { active: false } as any });
  await prisma.menuItem.updateMany({ where: { businessId: auth.businessId, categoryId: id }, data: { active: false } as any }).catch(() => null);
  return res.status(200).json({ ok: true });
});

const CreateItemSchema = z.object({
  categoryId: z.number().int().positive(),
  name: z.string().min(1).max(120),
  sku: z.string().min(1).max(80).optional(),
  price: z.number().nonnegative(),
  vatRate: z.number().min(0).max(1).optional(),
  active: z.boolean().optional().default(true),
  isKg: z.boolean().optional().default(false),
});

function slugSku(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

menuRouter.post('/items', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  if (!auth) return res.status(403).json({ error: 'forbidden' });
  const input = CreateItemSchema.parse(req.body || {});
  const category = await prisma.category.findFirst({ where: { businessId: auth.businessId, id: input.categoryId } });
  if (!category) return res.status(400).json({ error: 'invalid categoryId' });

  const baseSku = input.sku ? String(input.sku).trim() : slugSku(input.name);
  const sku = baseSku ? `${baseSku}-${Math.random().toString(36).slice(2, 6).toUpperCase()}` : `SKU-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const vat = typeof input.vatRate === 'number' ? input.vatRate : Number(process.env.VAT_RATE_DEFAULT || 0.2);

  const created = await prisma.menuItem.create({
    data: {
      businessId: auth.businessId,
      categoryId: input.categoryId,
      name: input.name.trim(),
      sku,
      price: input.price as any,
      vatRate: vat as any,
      active: input.active ?? true,
      isKg: input.isKg ?? false,
    } as any,
  });
  return res.status(201).json({ id: created.id, sku: created.sku });
});

const UpdateItemSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  price: z.number().nonnegative().optional(),
  vatRate: z.number().min(0).max(1).optional(),
  active: z.boolean().optional(),
  isKg: z.boolean().optional(),
  categoryId: z.number().int().positive().optional(),
});

menuRouter.put('/items/:id', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  if (!auth) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const input = UpdateItemSchema.parse(req.body || {});
  if (typeof input.categoryId === 'number') {
    const category = await prisma.category.findFirst({ where: { businessId: auth.businessId, id: input.categoryId } });
    if (!category) return res.status(400).json({ error: 'invalid categoryId' });
  }
  const updated = await prisma.menuItem.updateMany({
    where: { businessId: auth.businessId, id },
    data: {
      ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
      ...(typeof input.price === 'number' ? { price: input.price as any } : {}),
      ...(typeof input.vatRate === 'number' ? { vatRate: input.vatRate as any } : {}),
      ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
      ...(typeof input.isKg === 'boolean' ? { isKg: input.isKg } : {}),
      ...(typeof input.categoryId === 'number' ? { categoryId: input.categoryId } : {}),
    } as any,
  });
  if (!updated.count) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
});

menuRouter.delete('/items/:id', requireAuth, async (req: AuthedRequest, res) => {
  const auth = requireAdmin(req);
  if (!auth) return res.status(403).json({ error: 'forbidden' });
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const updated = await prisma.menuItem.updateMany({ where: { businessId: auth.businessId, id }, data: { active: false } as any });
  if (!updated.count) return res.status(404).json({ error: 'not found' });
  return res.status(200).json({ ok: true });
});

