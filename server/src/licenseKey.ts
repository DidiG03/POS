/**
 * POS license key: HMAC of Stripe customer id + email + edition.
 * Deterministic so restore-by-email returns the same key without a database.
 * v1 keys (customer + email only) still parse for tills activated before edition.
 */
import crypto from 'node:crypto';

export type LicenseEdition = 'RESTAURANT' | 'STORE';

export type LicensePayload = {
  v: 1 | 2;
  cid: string;
  em: string;
  ed?: LicenseEdition;
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

export function parseLicenseEdition(raw: unknown): LicenseEdition | '' {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  return v === 'STORE' || v === 'RESTAURANT' ? v : '';
}

export function issueLicenseKey(
  customerId: string,
  email: string,
  secret: string,
  edition: LicenseEdition,
): string {
  const payload: LicensePayload = {
    v: 2,
    cid: String(customerId).trim(),
    em: normalizeLicenseEmail(email),
    ed: edition,
  };
  if (!payload.cid || !payload.em || !payload.ed || !secret) {
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
    const cid = String(json?.cid || '').trim();
    const em = normalizeLicenseEmail(String(json?.em || ''));
    if (!cid || !em) return null;
    if (json?.v === 2) {
      const ed = parseLicenseEdition(json.ed);
      if (!ed) return null;
      return { v: 2, cid, em, ed };
    }
    if (json?.v === 1) {
      return { v: 1, cid, em };
    }
    return null;
  } catch {
    return null;
  }
}
