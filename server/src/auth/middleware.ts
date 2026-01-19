import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type AuthContext } from './jwt.js';
import { prisma } from '../db.js';

export type AuthedRequest = Request & { auth?: AuthContext };

export function authMiddleware(req: AuthedRequest, _res: Response, next: NextFunction) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const ctx = verifyToken(token);
    if (ctx) req.auth = ctx;
  }
  next();
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ error: 'unauthorized' });
  try {
    const biz = await prisma.business.findUnique({ where: { id: req.auth.businessId } }).catch(() => null);
    if (!biz || (biz as any).active === false) return res.status(401).json({ error: 'unauthorized' });
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

export function requireRole(role: AuthContext['role']) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: 'unauthorized' });
    if (req.auth.role !== role) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

