/**
 * POS license key: HMAC of Stripe customer id + email.
 * Deterministic so restore-by-email returns the same key without a database.
 */
import crypto from 'node:crypto';

export type LicensePayload = {
  v: 1;
  cid: string;
  em: string;
};

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

export function normalizeLicenseEmail(email: string): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export function issueLicenseKey(
  customerId: string,
  email: string,
  secret: string,
): string {
  const payload: LicensePayload = {
    v: 1,
    cid: String(customerId).trim(),
    em: normalizeLicenseEmail(email),
  };
  if (!payload.cid || !payload.em || !secret) {
    throw new Error('Cannot issue license key');
  }
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `POS1.${body}.${mac}`;
}

export function parseLicenseKey(
  key: string,
  secret: string,
): LicensePayload | null {
  const raw = String(key || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'POS1') return null;
  const [, body, mac] = parts;
  const expected = b64url(
    crypto.createHmac('sha256', secret).update(body).digest(),
  );
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = JSON.parse(
      fromB64url(body).toString('utf8'),
    ) as LicensePayload;
    if (json?.v !== 1 || !json.cid || !json.em) return null;
    return { v: 1, cid: String(json.cid), em: normalizeLicenseEmail(json.em) };
  } catch {
    return null;
  }
}
