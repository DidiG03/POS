/**
 * Authorization policy for every IPC channel.
 *
 * The main process exposes ~111 channels and, historically, checked the caller
 * on exactly one of them (`auth:createUser`). Anything with a preload bridge —
 * the KDS window, the reservations window, or injected script in any renderer —
 * could restore a database backup or rewrite settings just by naming the
 * channel. This table is the allow-list that closes that gap.
 *
 * Every channel must appear here. `ipcPolicy.test.ts` fails the build if a
 * handler is registered without a policy, so new channels cannot be added
 * without making a deliberate access decision.
 *
 * Deciding what to write for a new channel:
 *   - `public`  — reachable before anyone logs in (boot data, the login screen
 *                 itself, window launchers). Keep this list short and make sure
 *                 the handler returns nothing sensitive.
 *   - `session` — any authenticated user. Right for "my own data" reads and for
 *                 things every shell needs.
 *   - roles     — the specific roles allowed. Prefer this.
 *
 * `windows` additionally grants the channel to a shell regardless of session.
 * It exists for the Electron KDS window, which by design has no login screen
 * (`RequireKdsAccess` returns straight through outside the browser), and for
 * the standalone KDS kiosk build.
 */

import type { RateLimitOptions } from './security';
import type { WindowKind } from './ipcSession';

export type IpcAccess = 'public' | 'session';

export interface IpcPolicy {
  allow: IpcAccess | readonly string[];
  windows?: readonly WindowKind[];
  rateLimit?: RateLimitOptions;
}

/** Back-office. Anything that changes configuration, staff, or money history. */
const ADMIN = ['ADMIN'] as const;

/** Roles that can work the floor. Mirrors `isClockOnlyRole` in @shared/utils/roles. */
const POS = ['ADMIN', 'CASHIER', 'WAITER'] as const;

/** POS plus HOST so the reservations floor can see open tickets. */
const POS_AND_HOST = ['ADMIN', 'CASHIER', 'WAITER', 'HOST'] as const;

/** Roles that work tickets in the kitchen. */
const KITCHEN = [
  'ADMIN',
  'CASHIER',
  'KP',
  'CHEF',
  'HEAD_CHEF',
  'FOOD_RUNNER',
] as const;

/** The reservations shell. */
const HOST = ['ADMIN', 'HOST'] as const;

/** Shells that legitimately run without a login. */
const KDS_WINDOWS = ['kds'] as const;

/** Dedicated host reservations window (PIN is on that renderer). */
const RESERVATIONS_WINDOWS = ['reservations'] as const;

export const IPC_POLICIES: Readonly<Record<string, IpcPolicy>> = {
  // ---------------------------------------------------------------- admin
  'admin:getOverview': { allow: ADMIN },
  'admin:getReview': { allow: ADMIN },
  'admin:getSalesTrends': { allow: ADMIN },
  'admin:getSecurityLog': { allow: ADMIN },
  'admin:getTopSellingToday': { allow: ADMIN },
  'admin:listNotifications': { allow: ADMIN },
  'admin:listShifts': { allow: ADMIN },
  'admin:listTicketCounts': { allow: ADMIN },
  'admin:listTicketsByUser': { allow: ADMIN },
  'admin:markAllNotificationsRead': { allow: ADMIN },
  // The login screen offers an "Admin" button before anyone has authenticated.
  // Opening the window is harmless: the window renders its own login and every
  // admin channel is gated independently.
  'admin:openWindow': { allow: 'public' },

  // ----------------------------------------------------------------- auth
  // First-run setup has no admin to authorise creating the first admin, so the
  // handler itself allows exactly one bootstrap user and requires an ADMIN
  // session for every subsequent create.
  'auth:createUser': { allow: 'public', rateLimit: { maxAttempts: 20 } },
  'auth:deleteUser': { allow: ADMIN },
  // Self-revoke; nothing to protect.
  'auth:endSession': { allow: 'public' },
  // Drives the login screen's user picker.
  'auth:listUsers': { allow: 'public' },
  'auth:loginWithPin': {
    allow: 'public',
    rateLimit: { maxAttempts: 30, windowMs: 60 * 1000 },
  },
  'auth:logoutAdmin': { allow: 'public' },
  // The token *is* the credential, so this is necessarily reachable before a
  // session exists. Rate-limited because it is the one channel where guessing
  // a token would be worth an attacker's time.
  'auth:resumeSession': {
    allow: 'public',
    rateLimit: { maxAttempts: 20, windowMs: 60 * 1000 },
  },
  'auth:syncStaffFromApi': { allow: ADMIN },
  'auth:updateUser': { allow: ADMIN, rateLimit: { maxAttempts: 20 } },
  'auth:verifyManagerPin': {
    allow: 'session',
    rateLimit: { maxAttempts: 20, windowMs: 60 * 1000 },
  },

  // -------------------------------------------------------------- backups
  'backups:create': { allow: ADMIN },
  'backups:list': { allow: ADMIN },
  'backups:restore': { allow: ADMIN },

  // -------------------------------------------------------------- billing
  'billing:createCheckoutSession': { allow: ADMIN },
  'billing:createPortalSession': { allow: ADMIN },
  // Checked during boot to decide whether the app is usable at all.
  'billing:getStatus': { allow: 'public' },
  'billing:getStatusLive': { allow: ADMIN },

  // -------------------------------------------------------------- license
  // First-run paywall, before any user exists.
  'license:getStatus': { allow: 'public' },
  'license:getPlans': { allow: 'public' },
  'license:createCheckout': {
    allow: 'public',
    rateLimit: { maxAttempts: 10, windowMs: 60 * 1000 },
  },
  'license:activateSession': {
    allow: 'public',
    rateLimit: { maxAttempts: 20, windowMs: 60 * 1000 },
  },
  'license:activateKey': {
    allow: 'public',
    rateLimit: { maxAttempts: 20, windowMs: 60 * 1000 },
  },
  'license:restore': {
    allow: 'public',
    rateLimit: { maxAttempts: 8, windowMs: 60 * 60 * 1000 },
  },
  'license:createPortalSession': { allow: ADMIN },

  // --------------------------------------------------------------- covers
  'covers:getLast': { allow: POS },
  'covers:save': { allow: POS },

  // ------------------------------------------------------------------ kds
  'kds:bump': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:bumpItem': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:clearDone': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:debug': { allow: ADMIN, windows: KDS_WINDOWS },
  'kds:getCookerMode': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:getEnabledStations': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:getTicketDetail': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:listTickets': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:openWindow': { allow: ADMIN },
  'kds:recall': { allow: KITCHEN, windows: KDS_WINDOWS },
  'kds:setCookerMode': { allow: KITCHEN, windows: KDS_WINDOWS },

  // --------------------------------------------------------------- layout
  // Reading a floor plan is harmless and every shell needs it, including the
  // reservations panel run by a HOST.
  'layout:get': { allow: 'session' },
  'layout:getMerges': { allow: 'session', windows: RESERVATIONS_WINDOWS },
  'layout:setMerges': { allow: 'session', windows: RESERVATIONS_WINDOWS },
  // Floor-plan editing is an owner action (`canEditLayout` is currently off in
  // the UI); keep the channel closed to the floor either way.
  'layout:save': { allow: ADMIN },

  // ----------------------------------------------------------------- menu
  'menu:createCategory': { allow: ADMIN },
  'menu:createItem': { allow: ADMIN },
  'menu:deleteCategory': { allow: ADMIN },
  'menu:deleteItem': { allow: ADMIN },
  'menu:listCategoriesWithItems': { allow: POS },
  'menu:updateCategory': { allow: ADMIN },
  'menu:updateItem': { allow: ADMIN },

  // -------------------------------------------------------------- network
  // Shown on the pairing/setup screen before login so a tablet can find the host.
  'network:getIps': { allow: 'public' },

  // -------------------------------------------------------- notifications
  'notifications:list': { allow: 'session' },
  'notifications:markAllRead': { allow: 'session' },

  // -------------------------------------------------------------- offline
  'offline:getStatus': { allow: 'public' },

  // ---------------------------------------------------------------- print
  'print:cancelRetry': { allow: ADMIN },
  'print:listRetries': { allow: ADMIN },
  'printer:list': { allow: ADMIN },
  'printer:scanNetwork': { allow: ADMIN },
  'printer:listSerialPorts': { allow: ADMIN },

  // -------------------------------------------------------------- reports
  // "My" reports are scoped to the caller inside the handler.
  'reports:getMyOverview': { allow: 'session' },
  'reports:getMySalesTrends': { allow: 'session' },
  'reports:getMyTopSellingToday': { allow: 'session' },
  'reports:listMyActiveTickets': { allow: 'session' },
  'reports:listMyPaidTickets': { allow: 'session' },
  'reports:listMyVoidedTickets': { allow: 'session' },

  // ------------------------------------------------------------- requests
  'requests:approve': { allow: POS },
  'requests:create': { allow: POS },
  'requests:listForOwner': { allow: 'session' },
  'requests:markApplied': { allow: POS },
  'requests:pollApprovedForTable': { allow: POS },
  'requests:reject': { allow: POS },

  // --------------------------------------------------------- reservations
  'reservations:create': { allow: HOST },
  'reservations:delete': { allow: HOST },
  'reservations:list': { allow: HOST },
  'reservations:listCounts': { allow: HOST },
  // Login-screen button, same reasoning as `admin:openWindow`.
  'reservations:openWindow': { allow: 'public' },
  'reservations:setStatus': { allow: HOST },
  'reservations:update': { allow: HOST },

  // ------------------------------------------------------------- settings
  'settings:connectGoogleCalendar': { allow: ADMIN },
  'settings:disconnectGoogleCalendar': { allow: ADMIN },
  // Read during boot for locale, currency and feature flags. The handler
  // redacts credentials before returning.
  'settings:get': { allow: 'public' },
  'settings:getFiscalTokenHint': { allow: ADMIN },
  'settings:getGoogleCalendarStatus': { allow: ADMIN },
  'settings:listGoogleCalendars': { allow: ADMIN },
  'settings:setPrinter': { allow: ADMIN },
  'settings:syncGoogleCalendar': { allow: ADMIN },
  'settings:testFiscalConnection': { allow: ADMIN },
  'settings:testFiscalMinimalInvoice': { allow: ADMIN },
  'settings:listFiscalReviews': { allow: ADMIN },
  'settings:resolveFiscalReview': { allow: ADMIN },
  'settings:testPrint': { allow: ADMIN },
  'settings:testPrintProfile': { allow: ADMIN },
  'settings:testPrintVerbose': { allow: ADMIN },
  'settings:update': { allow: ADMIN },

  // --------------------------------------------------------------- shifts
  'shifts:clockIn': { allow: 'session' },
  'shifts:clockOut': { allow: 'session' },
  'shifts:getOpen': { allow: 'session' },
  // The login screen marks which staff are already clocked in, so this is read
  // before anyone authenticates. It returns user ids only, and that screen
  // already lists every staff member by name.
  'shifts:listOpen': { allow: 'public' },

  // --------------------------------------------------------------- system
  'system:openExternal': { allow: 'session' },

  // --------------------------------------------------------------- tables
  // HOST (and the dedicated reservations window) may read which tables have
  // an open POS ticket so the floor can paint them occupied and block merge.
  'tables:listOpen': { allow: POS_AND_HOST, windows: RESERVATIONS_WINDOWS },
  'tables:getFloorSnapshot': { allow: POS },
  'tables:setOpen': { allow: POS },
  'tables:transfer': { allow: POS },

  // -------------------------------------------------------------- tickets
  'tickets:getLatestForTable': { allow: POS },
  'tickets:getTableTooltip': {
    allow: POS_AND_HOST,
    windows: RESERVATIONS_WINDOWS,
  },
  'tickets:listPaidTables': {
    allow: POS_AND_HOST,
    windows: RESERVATIONS_WINDOWS,
  },
  // A busy terminal fires these constantly; the ceiling is only there to stop
  // a runaway loop, not to pace normal service.
  'tickets:log': { allow: POS, rateLimit: { maxAttempts: 100 } },
  'tickets:print': { allow: POS },
  'tickets:voidItem': { allow: POS },
  'tickets:voidTicket': { allow: POS },

  // -------------------------------------------------------------- updater
  // The update banner renders in the staff shell and in the standalone KDS
  // kiosk, so installing cannot be admin-only without stranding those builds.
  'updater:checkForUpdates': { allow: 'session', windows: KDS_WINDOWS },
  'updater:downloadUpdate': { allow: 'session', windows: KDS_WINDOWS },
  'updater:getStatus': { allow: 'public' },
  'updater:installUpdate': { allow: 'session', windows: KDS_WINDOWS },
};

export function policyFor(channel: string): IpcPolicy | undefined {
  return IPC_POLICIES[channel];
}
