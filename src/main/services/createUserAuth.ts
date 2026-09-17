/**
 * Shared rules for creating staff, used by both IPC and the LAN HTTP API.
 *
 * First-run setup has no admin session yet, so exactly one bootstrap user is
 * allowed — and only if it is an ADMIN. Every later create needs a live ADMIN
 * session. The Admin companion talks to the till over LAN, so the HTTP path
 * must use the same exception as `auth:createUser` or "Create admin" returns
 * 401 unauthorized.
 */

export type CreateUserAuthDecision =
  | { allow: true }
  | {
      allow: false;
      reason: 'bootstrap_requires_admin' | 'admin_session_required';
    };

export function isFirstAdminLanBootstrap(
  method: string,
  pathname: string,
  userCount: number,
): boolean {
  return (
    userCount === 0 &&
    String(method || '').toUpperCase() === 'POST' &&
    pathname === '/auth/create-user'
  );
}

export function authorizeCreateUser(input: {
  userCount: number;
  sessionRole?: string | null;
  requestedRole: string;
}): CreateUserAuthDecision {
  const requested = String(input.requestedRole || '').toUpperCase();
  if (input.userCount === 0) {
    if (requested !== 'ADMIN') {
      return { allow: false, reason: 'bootstrap_requires_admin' };
    }
    return { allow: true };
  }
  if (String(input.sessionRole || '').toUpperCase() !== 'ADMIN') {
    return { allow: false, reason: 'admin_session_required' };
  }
  return { allow: true };
}
