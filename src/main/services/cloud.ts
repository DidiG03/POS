import { coreServices } from './core';
import { prisma } from '@db/client';

type CloudConfig = { backendUrl: string; businessCode: string };

// Per-window cloud sessions (allows waiter UI + admin UI simultaneously)
type CloudSession = { token: string; businessCode: string; role: 'ADMIN' | 'CASHIER' | 'WAITER'; userId: number };
const perSender = new Map<number, CloudSession>();

// Persist sessions separately so admin + staff can coexist across refresh/restart.
const CLOUD_SESSION_KEY = 'cloud:session'; // legacy (pre-split); treated as STAFF
const CLOUD_SESSION_STAFF_KEY = 'cloud:session:staff';
const CLOUD_SESSION_ADMIN_KEY = 'cloud:session:admin';

let staffSession: CloudSession | null = null;
let adminSession: CloudSession | null = null;

function normalizeBaseUrl(u: string) {
  return u.trim().replace(/\/+$/g, '');
}

export async function getCloudConfig(): Promise<CloudConfig | null> {
  const settings = await coreServices.readSettings();
  const backendUrl = String((settings as any)?.cloud?.backendUrl || '').trim();
  const businessCode = String((settings as any)?.cloud?.businessCode || '').trim();
  if (!backendUrl || !businessCode) return null;
  return { backendUrl: normalizeBaseUrl(backendUrl), businessCode };
}

async function persistCloudSession(key: string, next: { token: string | null; businessCode: string | null; role: any; userId: any }) {
  try {
    if (!next.token || !next.businessCode) {
      await prisma.syncState.delete({ where: { key } }).catch(() => null);
      return;
    }
    const valueJson = {
      token: String(next.token),
      businessCode: String(next.businessCode),
      role: next.role ? String(next.role) : null,
      userId: next.userId ? Number(next.userId) : null,
      savedAt: new Date().toISOString(),
    };
    await prisma.syncState.upsert({
      where: { key },
      create: { key, valueJson },
      update: { valueJson },
    });
  } catch {
    // ignore persistence errors (should never block app)
  }
}

function pickStoreKey(role: CloudSession['role'] | null | undefined) {
  return role === 'ADMIN' ? CLOUD_SESSION_ADMIN_KEY : CLOUD_SESSION_STAFF_KEY;
}

async function bootstrapCloudSession() {
  try {
    const cfg = await getCloudConfig().catch(() => null);
    if (!cfg) return;
    const [staffRow, adminRow, legacyRow] = await Promise.all([
      prisma.syncState.findUnique({ where: { key: CLOUD_SESSION_STAFF_KEY } }).catch(() => null),
      prisma.syncState.findUnique({ where: { key: CLOUD_SESSION_ADMIN_KEY } }).catch(() => null),
      prisma.syncState.findUnique({ where: { key: CLOUD_SESSION_KEY } }).catch(() => null),
    ]);

    const staffSaved = (staffRow?.valueJson as any) || (legacyRow?.valueJson as any) || null;
    const adminSaved = (adminRow?.valueJson as any) || null;

    const load = (saved: any): CloudSession | null => {
      if (!saved) return null;
      const savedBusinessCode = String(saved.businessCode || '').trim();
      const savedToken = String(saved.token || '').trim();
      if (!savedToken || !savedBusinessCode) return null;
      if (savedBusinessCode !== cfg.businessCode) return null;
      const role = saved.role ? (String(saved.role) as any) : null;
      const userId = saved.userId ? Number(saved.userId) : 0;
      if (!role || !userId) return null;
      return { token: savedToken, businessCode: savedBusinessCode, role, userId } as CloudSession;
    };

    staffSession = load(staffSaved);
    adminSession = load(adminSaved);

    // Validate sessions once (best-effort). If invalid, clear that one.
    const validate = async (s: CloudSession, key: string) => {
      try {
        const me = await cloudJson<any>('GET', '/auth/me', undefined, { requireAuth: true, senderId: 0, businessCodeHint: s.businessCode });
        const role = me?.user?.role ? (String(me.user.role) as any) : s.role;
        const userId = me?.user?.id ? Number(me.user.id) : s.userId;
        const refreshed = { ...s, role, userId } as CloudSession;
        if (key === CLOUD_SESSION_ADMIN_KEY) adminSession = refreshed;
        else staffSession = refreshed;
        await persistCloudSession(key, { token: refreshed.token, businessCode: refreshed.businessCode, role: refreshed.role, userId: refreshed.userId });
      } catch {
        if (key === CLOUD_SESSION_ADMIN_KEY) adminSession = null;
        else staffSession = null;
        await persistCloudSession(key, { token: null, businessCode: null, role: null, userId: null });
      }
    };

    await Promise.all([
      staffSession ? validate(staffSession, CLOUD_SESSION_STAFF_KEY) : Promise.resolve(),
      adminSession ? validate(adminSession, CLOUD_SESSION_ADMIN_KEY) : Promise.resolve(),
    ]);
  } catch {
    // ignore
  }
}

export function setCloudToken(next: string | null, businessCode: string | null) {
  // Treat as staff token (role unknown). Do NOT set userId=0 (it breaks has/get logic).
  if (!next || !businessCode) {
    staffSession = null;
    void persistCloudSession(CLOUD_SESSION_STAFF_KEY, { token: null, businessCode: null, role: null, userId: null });
    return;
  }
  staffSession = null;
  void persistCloudSession(CLOUD_SESSION_STAFF_KEY, { token: next, businessCode, role: null, userId: null });
}

export function setCloudSession(next: { token: string; businessCode: string; role: 'ADMIN' | 'CASHIER' | 'WAITER'; userId: number }) {
  const s: CloudSession = { token: next.token, businessCode: next.businessCode, role: next.role, userId: next.userId };
  if (next.role === 'ADMIN') adminSession = s;
  else staffSession = s;
  void persistCloudSession(pickStoreKey(next.role), { token: s.token, businessCode: s.businessCode, role: s.role, userId: s.userId });
}

export function setCloudSessionForSender(senderId: number, next: CloudSession) {
  if (!senderId) return;
  perSender.set(senderId, next);
}

export function clearCloudSessionForSender(senderId: number) {
  if (!senderId) return;
  perSender.delete(senderId);
}

export function hasCloudSessionForSender(senderId: number, businessCode: string): boolean {
  const s = perSender.get(senderId);
  return Boolean(s && s.businessCode === businessCode && s.token);
}

export function isCloudAdminForSender(senderId: number, businessCode: string): boolean {
  const s = perSender.get(senderId);
  return Boolean(s && s.businessCode === businessCode && s.role === 'ADMIN' && s.token);
}

export function clearCloudAdminSession() {
  adminSession = null;
  void persistCloudSession(CLOUD_SESSION_ADMIN_KEY, { token: null, businessCode: null, role: null, userId: null });
}

export function clearCloudStaffSession() {
  staffSession = null;
  void persistCloudSession(CLOUD_SESSION_STAFF_KEY, { token: null, businessCode: null, role: null, userId: null });
}

export function clearCloudSession() {
  staffSession = null;
  adminSession = null;
  void persistCloudSession(CLOUD_SESSION_STAFF_KEY, { token: null, businessCode: null, role: null, userId: null });
  void persistCloudSession(CLOUD_SESSION_ADMIN_KEY, { token: null, businessCode: null, role: null, userId: null });
  // Cleanup legacy key too
  void persistCloudSession(CLOUD_SESSION_KEY, { token: null, businessCode: null, role: null, userId: null });
}

export function hasCloudSession(businessCode: string): boolean {
  return Boolean((staffSession && staffSession.businessCode === businessCode && staffSession.token) || (adminSession && adminSession.businessCode === businessCode && adminSession.token));
}

export function isCloudAdmin(businessCode: string): boolean {
  return Boolean(adminSession && adminSession.businessCode === businessCode && adminSession.role === 'ADMIN' && adminSession.token);
}

export function getCloudSessionUserId(businessCode: string): number | null {
  if (staffSession && staffSession.businessCode === businessCode && staffSession.userId) return staffSession.userId;
  if (adminSession && adminSession.businessCode === businessCode && adminSession.userId) return adminSession.userId;
  return null;
}

export async function cloudJson<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  opts?: { requireAuth?: boolean; businessCodeHint?: string; senderId?: number },
): Promise<T> {
  const cfg = await getCloudConfig();
  if (!cfg) throw new Error('Cloud backend not configured');

  const requireAuth = Boolean(opts?.requireAuth);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const senderId = Number(opts?.senderId || 0);
  const senderSession = senderId ? perSender.get(senderId) : null;
  const usedSenderToken = Boolean(senderSession && senderSession.businessCode === cfg.businessCode && senderSession.token);
  const wantsAdmin = String(path || '').startsWith('/admin');
  // IMPORTANT:
  // - For admin endpoints, NEVER fall back to a staff token (it will 403 and cause confusing "zeros").
  // - Prefer a per-sender token only if it matches the endpoint (ADMIN for /admin/*).
  const senderIsAdmin = Boolean(senderSession && senderSession.role === 'ADMIN');
  const picked: CloudSession | null = wantsAdmin
    ? ((usedSenderToken && senderIsAdmin) ? senderSession! : (adminSession || null))
    : ((usedSenderToken ? senderSession! : null) || staffSession || adminSession);

  if (picked && picked.businessCode === cfg.businessCode && picked.token) {
    headers.Authorization = `Bearer ${picked.token}`;
  } else if (requireAuth) {
    throw new Error(wantsAdmin ? 'Admin login required' : 'Not logged in to cloud backend');
  }

  const url = `${cfg.backendUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  } as any);

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || res.statusText || 'request failed';
    if (res.status === 401 || res.status === 403) {
      // Token expired/invalid → clear session so the app forces re-login.
      if (usedSenderToken && senderId && picked?.token === senderSession?.token) {
        clearCloudSessionForSender(senderId);
      } else if (picked?.token && adminSession?.token === picked.token) {
        clearCloudAdminSession();
      } else if (picked?.token && staffSession?.token === picked.token) {
        clearCloudStaffSession();
      } else if (wantsAdmin) {
        // If we attempted an admin endpoint without a valid admin token, clear admin session (best-effort).
        clearCloudAdminSession();
      } else {
        clearCloudStaffSession();
      }
    }
    throw new Error(String(msg));
  }
  return data as T;
}

// Try to restore cloud session on app startup.
void bootstrapCloudSession();

