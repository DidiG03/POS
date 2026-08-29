/**
 * Host license: Stripe Checkout + a key stored in userData.
 * Tablets never see this — they talk to the LAN API on a licensed till.
 */
import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type LicenseStatus = 'ACTIVE' | 'PAST_DUE' | 'PAUSED';

export interface StoredLicense {
  key: string;
  email: string;
  status: LicenseStatus;
  currentPeriodEnd: string | null;
  lastValidatedAt: number;
}

export interface LicensePublicStatus {
  /** This process is the till host and must be licensed. */
  required: boolean;
  licensed: boolean;
  email?: string;
  key?: string;
  status?: LicenseStatus;
  currentPeriodEnd?: string | null;
  message?: string | null;
  billingConfigured: boolean;
}

const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const PROTOCOL = 'codeorbit-pos';

function billingBase(): string {
  return String(process.env.POS_BILLING_URL || '')
    .trim()
    .replace(/\/+$/g, '');
}

export function isLicenseRequired(): boolean {
  if (String(process.env.POS_LICENSE_BYPASS || '').trim() === '1') {
    return false;
  }
  // Packaged builds bake POS_BILLING_URL in entry.ts and must be licensed.
  // Unpackaged `npm run dev` keeps the till + LAN tablets usable even when
  // that URL is in `.env` for billing UI work — otherwise merge/save 403s
  // because the HTTP API never starts.
  try {
    if (!app.isPackaged) return false;
  } catch {
    // `app` is unavailable in some unit-test imports.
  }
  return Boolean(billingBase());
}

export function licenseFilePath(): string {
  return path.join(app.getPath('userData'), 'license.json');
}

export function readStoredLicense(): StoredLicense | null {
  try {
    const raw = fs.readFileSync(licenseFilePath(), 'utf8');
    const j = JSON.parse(raw) as StoredLicense;
    if (!j?.key) return null;
    return j;
  } catch {
    return null;
  }
}

export function writeStoredLicense(next: StoredLicense): void {
  fs.writeFileSync(licenseFilePath(), JSON.stringify(next, null, 2), 'utf8');
}

export function clearStoredLicense(): void {
  try {
    fs.unlinkSync(licenseFilePath());
  } catch {
    // ignore
  }
}

async function billingFetch(url: string, init: RequestInit): Promise<Response> {
  // Electron's Node `fetch` (undici) often hangs on TLS to Vercel; Chromium's
  // net.fetch uses the same stack as the rest of the app.
  if (app.isReady()) {
    return await net.fetch(url, init);
  }
  return await fetch(url, init);
}

async function billingJson<T>(pathName: string, body: unknown): Promise<T> {
  const base = billingBase();
  if (!base)
    throw new Error('Billing server is not configured (POS_BILLING_URL)');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await billingFetch(`${base}${pathName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        String(
          (data as any)?.error || res.statusText || 'Billing request failed',
        ),
      );
    }
    return data as T;
  } catch (e: any) {
    const cause = e?.cause?.message || e?.cause?.code || '';
    const msg = String(e?.message || 'Billing request failed');
    throw new Error(cause ? `${msg} (${cause})` : msg);
  } finally {
    clearTimeout(t);
  }
}

function persistFromRemote(r: {
  licenseKey?: string;
  email?: string;
  status?: string;
  currentPeriodEnd?: string | null;
}): StoredLicense {
  const stored: StoredLicense = {
    key: String(r.licenseKey || ''),
    email: String(r.email || ''),
    status:
      (String(r.status || 'ACTIVE').toUpperCase() as LicenseStatus) || 'ACTIVE',
    currentPeriodEnd: r.currentPeriodEnd ? String(r.currentPeriodEnd) : null,
    lastValidatedAt: Date.now(),
  };
  if (!stored.key)
    throw new Error('Billing server did not return a license key');
  writeStoredLicense(stored);
  return stored;
}

export async function getLicenseStatus(): Promise<LicensePublicStatus> {
  const required = isLicenseRequired();
  const configured = Boolean(billingBase());
  if (!required) {
    return { required: false, licensed: true, billingConfigured: configured };
  }
  if (!configured) {
    return {
      required: true,
      licensed: false,
      billingConfigured: false,
      message:
        'POS_BILLING_URL is not set. Deploy the billing server and set that URL on this till.',
    };
  }
  const stored = readStoredLicense();
  if (!stored?.key) {
    return {
      required: true,
      licensed: false,
      billingConfigured: true,
      message: 'Subscribe to unlock this POS.',
    };
  }
  try {
    const remote = await billingJson<{
      valid?: boolean;
      status?: string;
      email?: string;
      currentPeriodEnd?: string | null;
      licenseKey?: string;
    }>('/license/validate', { key: stored.key });
    const status = String(
      remote.status || 'PAUSED',
    ).toUpperCase() as LicenseStatus;
    const next: StoredLicense = {
      key: String(remote.licenseKey || stored.key),
      email: String(remote.email || stored.email),
      status,
      currentPeriodEnd: remote.currentPeriodEnd
        ? String(remote.currentPeriodEnd)
        : stored.currentPeriodEnd,
      lastValidatedAt: Date.now(),
    };
    writeStoredLicense(next);
    const licensed = Boolean(remote.valid) && status === 'ACTIVE';
    return {
      required: true,
      licensed,
      email: next.email,
      key: next.key,
      status: next.status,
      currentPeriodEnd: next.currentPeriodEnd,
      billingConfigured: true,
      message: licensed
        ? null
        : 'Subscription is not active. Update payment or restore your license.',
    };
  } catch (e: any) {
    const age = Date.now() - Number(stored.lastValidatedAt || 0);
    const offlineOk =
      stored.status === 'ACTIVE' &&
      Number.isFinite(age) &&
      age >= 0 &&
      age < OFFLINE_GRACE_MS;
    return {
      required: true,
      licensed: offlineOk,
      email: stored.email,
      key: stored.key,
      status: stored.status,
      currentPeriodEnd: stored.currentPeriodEnd,
      billingConfigured: true,
      message: offlineOk
        ? 'Could not reach billing server; using the last successful check.'
        : String(e?.message || 'Could not validate license'),
    };
  }
}

export async function createCheckout(email: string): Promise<{
  url?: string;
  alreadyLicensed?: boolean;
  error?: string;
}> {
  try {
    const r = await billingJson<{
      url?: string;
      alreadyLicensed?: boolean;
      licenseKey?: string;
      email?: string;
      status?: string;
      currentPeriodEnd?: string | null;
      error?: string;
    }>('/checkout/create', { email });
    if (r.alreadyLicensed && r.licenseKey) {
      persistFromRemote(r);
    }
    return r;
  } catch (e: any) {
    return { error: String(e?.message || 'Could not start checkout') };
  }
}

export async function activateSession(sessionId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const r = await billingJson<{
      licenseKey?: string;
      email?: string;
      status?: string;
      currentPeriodEnd?: string | null;
    }>('/license/activate-session', { sessionId });
    persistFromRemote(r);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || 'Could not activate') };
  }
}

export async function activateKey(key: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const r = await billingJson<{
      valid?: boolean;
      licenseKey?: string;
      email?: string;
      status?: string;
      currentPeriodEnd?: string | null;
      error?: string;
    }>('/license/validate', { key });
    if (!r.valid) {
      return { ok: false, error: 'This key is not active' };
    }
    persistFromRemote({ ...r, licenseKey: r.licenseKey || key });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || 'Could not activate key') };
  }
}

export async function restoreByEmail(email: string): Promise<{
  ok: boolean;
  error?: string;
  message?: string;
}> {
  try {
    const r = await billingJson<{
      found?: boolean;
      licenseKey?: string;
      email?: string;
      status?: string;
      currentPeriodEnd?: string | null;
      message?: string;
    }>('/license/restore', { email });
    if (!r.found || !r.licenseKey) {
      return {
        ok: false,
        message:
          r.message ||
          'No active subscription found for that email. Check the address or pay to subscribe.',
      };
    }
    persistFromRemote(r);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || 'Could not restore') };
  }
}

export async function createPortalSession(): Promise<{
  url?: string;
  error?: string;
}> {
  const stored = readStoredLicense();
  if (!stored?.key) return { error: 'No license on this computer yet' };
  try {
    return await billingJson<{ url?: string }>('/license/portal', {
      key: stored.key,
    });
  } catch (e: any) {
    return { error: String(e?.message || 'Could not open billing portal') };
  }
}

export function registerLicenseProtocol(): void {
  try {
    if (process.defaultApp) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        path.resolve(process.argv[1] || '.'),
      ]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  } catch {
    // ignore
  }
}

export function sessionIdFromProtocolUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== `${PROTOCOL}:`) return null;
    const id = String(u.searchParams.get('session_id') || '').trim();
    return id.startsWith('cs_') ? id : null;
  } catch {
    return null;
  }
}
