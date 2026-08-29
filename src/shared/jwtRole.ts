/** Decode the `role` claim from a compact JWT. Verification happens on the host. */
export function jwtRole(token: string | null | undefined): string {
  const raw = String(token || '').trim();
  if (!raw) return '';
  try {
    const part = raw.split('.')[1];
    if (!part) return '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const json = JSON.parse(atob(b64 + '='.repeat(pad)));
    return String(json?.role || '').toUpperCase();
  } catch {
    return '';
  }
}

export function isHostOrAdminRole(role: unknown): boolean {
  const r = String(role || '').toUpperCase();
  return r === 'HOST' || r === 'ADMIN';
}
