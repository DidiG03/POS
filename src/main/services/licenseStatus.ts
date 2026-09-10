export type StoredLicenseStatus = 'ACTIVE' | 'PAST_DUE' | 'PAUSED';

export function parseStoredLicenseStatus(raw: unknown): StoredLicenseStatus {
  const s = String(raw || '').toUpperCase();
  if (s === 'ACTIVE' || s === 'PAST_DUE' || s === 'PAUSED') return s;
  return 'PAUSED';
}

/** Public IPC must not hand the HMAC key to waiters, KDS, or XSS. */
export function licenseStatusForRenderer<T extends { key?: string }>(
  st: T,
  revealKey: boolean,
): Omit<T, 'key'> & { key?: string } {
  if (revealKey) return st;
  const { key: _key, ...rest } = st;
  return rest;
}
