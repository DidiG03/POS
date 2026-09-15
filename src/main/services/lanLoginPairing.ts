/**
 * Pairing is the LAN invite for waiter / KDS / reservations devices.
 * Admin is the issuer of that code, so an admin PIN must not require it
 * or OneTap Admin cannot sign in until it has already signed in.
 */
export function lanLoginRequiresPairingCode(opts: {
  requirePairing: boolean;
  loopback: boolean;
  role: string | null | undefined;
}): boolean {
  if (!opts.requirePairing || opts.loopback) return false;
  return String(opts.role || '').toUpperCase() !== 'ADMIN';
}
