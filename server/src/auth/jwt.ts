import jwt from 'jsonwebtoken';
import { env } from '../env.js';

export type AuthContext = {
  businessId: string;
  userId: number;
  role:
    | 'ADMIN'
    | 'CASHIER'
    | 'WAITER'
    | 'KP'
    | 'CHEF'
    | 'HEAD_CHEF'
    | 'FOOD_RUNNER'
    | 'HOST'
    | 'BUSSER'
    | 'BARTENDER'
    | 'BARBACK'
    | 'CLEANER';
};

export function issueToken(ctx: AuthContext, ttlSeconds = 12 * 60 * 60): string {
  return jwt.sign(
    { businessId: ctx.businessId, sub: String(ctx.userId), role: ctx.role },
    env.jwtSecret,
    { expiresIn: ttlSeconds },
  );
}

export function verifyToken(token: string): AuthContext | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as any;
    const businessId = String(decoded?.businessId || '');
    const role = decoded?.role as AuthContext['role'];
    const userId = Number(decoded?.sub);
    if (!businessId || !Number.isFinite(userId) || userId <= 0) return null;
    if (
      role !== 'ADMIN' &&
      role !== 'CASHIER' &&
      role !== 'WAITER' &&
      role !== 'KP' &&
      role !== 'CHEF' &&
      role !== 'HEAD_CHEF' &&
      role !== 'FOOD_RUNNER' &&
      role !== 'HOST' &&
      role !== 'BUSSER' &&
      role !== 'BARTENDER' &&
      role !== 'BARBACK' &&
      role !== 'CLEANER'
    ) return null;
    return { businessId, userId, role };
  } catch {
    return null;
  }
}

