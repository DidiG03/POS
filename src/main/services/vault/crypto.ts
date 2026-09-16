/**
 * Passphrase wrapping for the database data key.
 *
 * The passphrase never touches disk. Argon2id stretches it into a key that
 * AES-256-GCM uses to wrap a random 256-bit DEK. That DEK is what libSQL
 * encrypts `pos.db` with. Changing the passphrase only re-wraps the DEK.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 200;

export type Argon2Params = {
  t: number;
  m: number;
  p: number;
};

/** Interactive unlock on a till PC. Tests inject cheaper params. */
export const DEFAULT_KDF: Argon2Params = { t: 2, m: 19_456, p: 1 };

const DEK_BYTES = 32;
const WRAP_IV_BYTES = 12;
const ARGON_MAXMEM = 64 * 1024 * 1024;

export type WrappedKey = {
  kdf: Argon2Params & { salt: string };
  iv: string;
  ct: string;
};

/**
 * Same secret the owner typed, even if macOS/Albanian IME stored ë as
 * combining marks, or the password field kept a trailing space.
 */
export function normalizePassphrase(passphrase: string): string {
  return String(passphrase || '')
    .normalize('NFC')
    .trim();
}

export function passphraseCandidates(secret: string): string[] {
  const raw = String(secret || '');
  const out: string[] = [];
  const add = (value: string) => {
    if (value && !out.includes(value)) out.push(value);
  };
  add(normalizePassphrase(raw));
  add(raw);
  add(raw.trim());
  add(raw.normalize('NFD').trim());
  add(raw.normalize('NFC'));
  return out;
}

export function validatePassphrase(
  passphrase: string,
): { ok: true } | { ok: false; error: string } {
  const value = normalizePassphrase(passphrase);
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    return { ok: false, error: 'too_short' };
  }
  if (value.length > MAX_PASSPHRASE_LENGTH) {
    return { ok: false, error: 'too_long' };
  }
  if (/^\d+$/.test(value)) {
    return { ok: false, error: 'digits_only' };
  }
  return { ok: true };
}

export async function unwrapPassphrase(
  secret: string,
  wrapped: WrappedKey,
): Promise<Buffer | null> {
  for (const candidate of passphraseCandidates(secret)) {
    const dek = await unwrapKey(candidate, wrapped);
    if (dek) return dek;
  }
  return null;
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

/** 16 random bytes as `xxxx-xxxx-...` hex. High entropy; not a PIN. */
export function generateRecoveryKey(): string {
  return formatRecoveryKey(randomBytes(16));
}

export function formatRecoveryKey(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex').toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    groups.push(hex.slice(i, i + 4));
  }
  return groups.join('-');
}

export function normalizeRecoveryKey(input: string): string {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
}

export function recoveryKeyToBytes(input: string): Buffer | null {
  const hex = normalizeRecoveryKey(input);
  if (hex.length !== 32 || !/^[0-9A-F]+$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

export function dekToEncryptionKey(dek: Buffer): string {
  return dek.toString('hex');
}

export async function wrapKey(
  secret: Buffer | string,
  dek: Buffer,
  kdf: Argon2Params = DEFAULT_KDF,
): Promise<WrappedKey> {
  const salt = randomBytes(16);
  const kek = await deriveKek(secret, salt, kdf);
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: { ...kdf, salt: salt.toString('hex') },
    iv: iv.toString('hex'),
    ct: Buffer.concat([enc, tag]).toString('hex'),
  };
}

export async function unwrapKey(
  secret: Buffer | string,
  wrapped: WrappedKey,
): Promise<Buffer | null> {
  try {
    const salt = Buffer.from(wrapped.kdf.salt, 'hex');
    const kek = await deriveKek(secret, salt, wrapped.kdf);
    const iv = Buffer.from(wrapped.iv, 'hex');
    const blob = Buffer.from(wrapped.ct, 'hex');
    if (blob.length < 16) return null;
    const ct = blob.subarray(0, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}

async function deriveKek(
  secret: Buffer | string,
  salt: Buffer,
  kdf: Argon2Params,
): Promise<Buffer> {
  const password =
    typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  const out = await argon2idAsync(password, salt, {
    t: kdf.t,
    m: kdf.m,
    p: kdf.p,
    dkLen: 32,
    maxmem: ARGON_MAXMEM,
  });
  return Buffer.from(out);
}
