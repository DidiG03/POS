/**
 * Authorization policy for the LAN HTTP API.
 *
 * This is the counterpart to `ipcPolicy.ts`, for the surface that tablets,
 * phones and kitchen displays actually use. The API already authenticates —
 * there is a global bearer-token gate with a public allow-list — but until now
 * it only *authorised* on the routes that happened to remember to check
 * `auth.role`. Four privileged routes had no check at all, so any logged-in
 * waiter on a tablet could read business-wide revenue through
 * `/admin/sales-trends` or rewrite printer and fiscal configuration through
 * `/settings/update`.
 *
 * Every route is listed here as `METHOD path`. `lanPolicy.test.ts` extracts the
 * routes from `api.ts` and fails if the two disagree in either direction, so a
 * new route cannot ship without an access decision.
 *
 * The existing role checks inside individual handlers are left in place. They
 * are finer-grained than this table can be — most are "you may only read your
 * own tickets unless you are an admin" — and this gate runs before them.
 */

/** Reachable without a token. Kept in step with `publicPaths` in `api.ts`. */
export type LanAccess = 'public' | 'session' | readonly string[];

export interface LanRoutePolicy {
  allow: LanAccess;
  /** Why a route is public, when that isn't self-evident. */
  note?: string;
}

const ADMIN = ['ADMIN'] as const;
const POS = ['ADMIN', 'CASHIER', 'WAITER'] as const;
const HOST = ['ADMIN', 'HOST'] as const;

export const LAN_ROUTE_POLICIES: Readonly<Record<string, LanRoutePolicy>> = {
  // ------------------------------------------------------- pre-auth surface
  // These are handled before the token gate; listed so the table describes the
  // whole API rather than just the part this check governs.
  'POST /pairing/verify': {
    allow: 'public',
    note: 'the pairing gate itself',
  },
  'POST /auth/login': { allow: 'public', note: 'issues the token' },
  'GET /auth/users': {
    allow: 'public',
    note: 'staff picker on the login screen',
  },
  'GET /events': {
    allow: 'session',
    note: 'SSE stream; verifies its own token',
  },

  // -------------------------------------------------------- boot-time reads
  'GET /settings': {
    allow: 'public',
    note: 'locale, currency, areas; credentials are redacted before sending',
  },
  'GET /offline/status': { allow: 'public' },
  'GET /shifts/open': {
    allow: 'public',
    note: 'login screen marks who is already clocked in',
  },
  'GET /menu/categories': {
    allow: 'public',
    note: 'kitchen displays render item names without logging in',
  },

  // ------------------------------------------------------------------- kds
  // Dedicated kitchen displays have no login screen, so these are open to
  // anyone who can reach the port. On the Electron side the equivalent grant is
  // tied to a window id that a renderer cannot forge; over the LAN there is no
  // such anchor yet. Closing this needs a device credential issued at KDS
  // setup — tracked separately, because it changes the setup flow on every
  // kitchen display.
  'GET /kds/tickets': { allow: 'public', note: 'kiosk; see note above' },
  'GET /kds/ticket-detail': { allow: 'public', note: 'kiosk' },
  'GET /kds/cooker-mode': { allow: 'public', note: 'kiosk' },
  'GET /kds/debug': { allow: 'public', note: 'kiosk reachability probe' },
  'POST /kds/bump': { allow: 'public', note: 'kiosk write' },
  'POST /kds/bump-item': { allow: 'public', note: 'kiosk write' },
  'POST /kds/recall': { allow: 'public', note: 'kiosk write' },
  'POST /kds/clear-done': { allow: 'public', note: 'kiosk write' },
  'POST /kds/cooker-mode': { allow: 'public', note: 'kiosk write' },

  // ------------------------------------------------------------------ auth
  'POST /auth/verify-manager-pin': { allow: 'session' },

  // ----------------------------------------------------------------- admin
  'GET /admin/overview': { allow: ADMIN },
  'GET /admin/sales-trends': { allow: ADMIN },

  // -------------------------------------------------------------- settings
  'POST /settings/update': { allow: ADMIN },

  // ----------------------------------------------------------------- print
  'POST /print/test': { allow: ADMIN },
  'POST /print/ticket': { allow: POS },

  // ---------------------------------------------------------------- layout
  'GET /layout/get': { allow: 'session' },
  'POST /layout/save': { allow: ADMIN },

  // ---------------------------------------------------------------- covers
  'GET /covers/last': { allow: POS },
  'POST /covers/save': { allow: POS },

  // --------------------------------------------------------------- reports
  // Scoped to the caller inside each handler.
  'GET /reports/my/overview': { allow: 'session' },
  'GET /reports/my/sales-trends': { allow: 'session' },
  'GET /reports/my/top-selling-today': { allow: 'session' },

  // -------------------------------------------------------------- requests
  'GET /requests/list-for-owner': { allow: 'session' },
  'GET /requests/poll-approved': { allow: POS },
  'POST /requests/approve': { allow: POS },
  'POST /requests/create': { allow: POS },
  'POST /requests/mark-applied': { allow: POS },
  'POST /requests/reject': { allow: POS },

  // ---------------------------------------------------------- reservations
  'GET /reservations': { allow: HOST },
  'GET /reservations/counts': { allow: HOST },
  'POST /reservations': { allow: HOST },
  'POST /reservations/delete': { allow: HOST },
  'POST /reservations/set-status': { allow: HOST },
  'POST /reservations/update': { allow: HOST },

  // ---------------------------------------------------------------- shifts
  'GET /shifts/get-open': { allow: 'session' },
  'POST /shifts/clock-in': { allow: 'session' },
  'POST /shifts/clock-out': { allow: 'session' },

  // ---------------------------------------------------------------- tables
  'GET /tables/open': { allow: POS },
  'POST /tables/open': { allow: POS },
  'POST /tables/transfer': { allow: POS },

  // --------------------------------------------------------------- tickets
  'POST /tickets': { allow: POS },
  'GET /tickets/latest': { allow: POS },
  'POST /tickets/void-item': { allow: POS },
  'POST /tickets/void-ticket': { allow: POS },
};

export type LanVerdict = 'allow' | 'forbidden' | 'unauthenticated' | 'unknown';

/**
 * Decide whether a request may proceed.
 *
 * `unknown` means the route is not in the table. The caller treats that as a
 * denial — a route nobody made a decision about should not be reachable — and
 * the coverage test makes sure it cannot happen by accident.
 */
export function authorizeLanRoute(
  method: string,
  pathname: string,
  role: string | null | undefined,
): LanVerdict {
  const policy = LAN_ROUTE_POLICIES[`${method.toUpperCase()} ${pathname}`];
  if (!policy) return 'unknown';
  if (policy.allow === 'public') return 'allow';

  const normalised = String(role || '').toUpperCase();
  if (!normalised) return 'unauthenticated';
  if (policy.allow === 'session') return 'allow';
  return policy.allow.includes(normalised) ? 'allow' : 'forbidden';
}
