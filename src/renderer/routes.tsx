import type { RouteObject } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import AppLayout from './app/AppLayout';
import AdminLayout from './app/AdminLayout';
import ReservationsLayout from './app/ReservationsLayout';
import React from 'react';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { useReservationSessionStore } from './stores/reservationSession';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isClockOnlyRole,
  canSeeReportsOnMobile,
  canSeeKdsOnMobile,
} from '@shared/utils/roles';
import { PageSpinner } from './components/PageSpinner';

const LoginPage = React.lazy(() => import('./app/pages/LoginPage'));
const TablesPage = React.lazy(() => import('./app/pages/TablesPage'));
const OrderPage = React.lazy(() => import('./app/pages/OrderPage'));
const ReportsPage = React.lazy(() => import('./app/pages/ReportsPage'));
const ClockPage = React.lazy(() => import('./app/pages/ClockPage'));
const AdminPage = React.lazy(() => import('./app/pages/AdminPage'));
const AdminTicketsPage = React.lazy(
  () => import('./app/pages/AdminTicketsPage'),
);
const AdminUserTicketsPage = React.lazy(
  () => import('./app/pages/AdminUserTicketsPage'),
);
const AdminSettingsPage = React.lazy(
  () => import('./app/pages/AdminSettingsPage'),
);
const AdminMenuPage = React.lazy(() => import('./app/pages/AdminMenuPage'));
const AdminReviewPage = React.lazy(() => import('./app/pages/AdminReviewPage'));
const KdsPage = React.lazy(() => import('./app/pages/KdsPage'));
const KdsSetupPage = React.lazy(() => import('./app/pages/KdsSetupPage'));
const ReservationsLoginPage = React.lazy(
  () => import('./app/pages/ReservationsLoginPage'),
);
const ReservationsFloorPage = React.lazy(
  () => import('./app/pages/ReservationsFloorPage'),
);
const ReservationsListPage = React.lazy(
  () => import('./app/pages/ReservationsListPage'),
);

function SuspenseFallback() {
  const { t } = useTranslation();
  return <PageSpinner message={t('routes.loading')} />;
}

function withSuspense(el: React.ReactElement) {
  return <React.Suspense fallback={<SuspenseFallback />}>{el}</React.Suspense>;
}

function withSuspenseNoFallback(el: React.ReactElement) {
  // Used for screens that already render their own boot/loading UI (e.g. LoginPage).
  return <React.Suspense fallback={null}>{el}</React.Suspense>;
}

function RequireAuth({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  // If running in browser (not Electron), require an open shift. This catches
  // the case where a persisted Zustand session (across page reloads) outlives
  // the actual shift — without this guard a clocked-out staffer could resume
  // POS access just by reopening the tab.
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const isKdsContext =
    typeof window !== 'undefined' &&
    (window.location.hash || '').startsWith('#/kds');
  // `ok` defaults to true so we never flash the login screen while the async
  // check is in flight; we only flip it to false when the server has
  // CONCLUSIVELY told us the shift is gone.
  const [ok, setOk] = React.useState<boolean>(true);
  useEffect(() => {
    if (!isBrowser || isKdsContext || !user?.id) {
      setOk(true);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    // Retry with backoff because a clock-in that completed milliseconds ago
    // may not be visible on the next read (the API call we made on the
    // login screen and this guard's call can race). Without this the user
    // sees /app/tables flash and then bounce back to the login screen.
    const check = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const open = await (window as any).api.shifts.getOpen(user.id);
        if (cancelled) return;
        if (open) {
          setOk(true);
          return;
        }
        if (attempts < 2) {
          attempts += 1;
          window.setTimeout(check, 600);
          return;
        }
        setOk(false);
      } catch {
        // Transient network/server error — never sign the user out from a
        // routing guard. The server-side handlers still reject any sensitive
        // action when the shift is missing, so this is safe.
        if (!cancelled) setOk(true);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [isBrowser, isKdsContext, user?.id]);
  if (!user) return withSuspenseNoFallback(<LoginPage />);
  if (isBrowser && !ok) return withSuspenseNoFallback(<LoginPage />);
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  // CORRECTNESS: Hooks MUST be called unconditionally and in the same order
  // every render. Read both stores at the top, then make routing decisions
  // afterward. (Previously these hooks lived after an early return, which
  // tripped react-hooks/rules-of-hooks.)
  const adminUser = useAdminSessionStore((s) => s.user);
  const staffUser = useSessionStore((s) => s.user);
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  // Admin panel is not available on browser/tablet clients
  if (isBrowser) return <Navigate to="/" replace />;
  // Admin window uses its own persisted session so it doesn't get overwritten by waiter login.
  const isAdminContext =
    typeof window !== 'undefined' &&
    (window.location.hash || '').startsWith('#/admin');
  const user = isAdminContext ? adminUser : staffUser;
  if (!user) return withSuspenseNoFallback(<LoginPage />);
  if (user.role !== 'ADMIN') return withSuspenseNoFallback(<LoginPage />);
  return children;
}

function RequireHost({ children }: { children: React.ReactElement }) {
  // Hooks first — same rationale as RequireAdmin (no conditional hooks).
  // The reservation panel runs in two shells: the dedicated Electron window
  // on the desktop, and the same SPA bundle inside Capacitor / mobile
  // browsers. We intentionally do NOT block browser clients here — hosts
  // need to manage reservations from their phones.
  const reservationUser = useReservationSessionStore((s) => s.user);
  const reservationExpires = useReservationSessionStore((s) => s.expiresAtMs);
  // Honor the session TTL so a stale session doesn't silently grant access.
  const expired =
    typeof reservationExpires === 'number' &&
    reservationExpires > 0 &&
    reservationExpires < Date.now();
  if (!reservationUser || expired) {
    return <Navigate to="/reservations" replace />;
  }
  const role = String((reservationUser as any).role || '').toUpperCase();
  if (role !== 'HOST' && role !== 'ADMIN') {
    return <Navigate to="/reservations" replace />;
  }
  return children;
}

function AppIndexRedirect() {
  const user = useSessionStore((s) => s.user);
  if (!user) return <Navigate to="/" replace />;
  return (
    <Navigate
      to={isClockOnlyRole((user as any).role) ? 'clock' : 'tables'}
      replace
    />
  );
}

function RequirePosAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  if (!user) return <Navigate to="/" replace />;
  if (isClockOnlyRole((user as any).role))
    return <Navigate to="/app/clock" replace />;
  return children;
}

function RequireClockAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  if (!user) return <Navigate to="/" replace />;
  // Requirement: waiters must NOT see/use the Clock page.
  if (String((user as any)?.role || '').toUpperCase() === 'WAITER') {
    return <Navigate to="/app/tables" replace />;
  }
  return children;
}

// On mobile (Capacitor / browser shell) only ADMIN and CASHIER may see
// the Reports screen. Other roles get redirected to Tables. The Electron
// desktop is unrestricted because admins use it for back-office work.
function RequireReportsAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  if (!user) return <Navigate to="/" replace />;
  if (isBrowser && !canSeeReportsOnMobile((user as any).role)) {
    return <Navigate to="/app/tables" replace />;
  }
  return children;
}

// KDS is intended for kitchen staff. On mobile, restrict to kitchen roles
// so a waiter who pastes a /kds deep link doesn't end up on a screen
// they can't act on. Electron stays open (the kitchen PC needs it).
//
// The standalone "Code Orbit KDS" Electron app sets `__KDS_APP__ = true`
// from its preload — that build is a kitchen-only kiosk so we skip the
// login/role gate entirely.
function RequireKdsAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  const isKdsApp =
    typeof window !== 'undefined' && Boolean((window as any).__KDS_APP__);
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  if (isKdsApp) return children;
  if (!isBrowser) return children;
  if (!user) return <Navigate to="/" replace />;
  if (!canSeeKdsOnMobile((user as any).role)) {
    return <Navigate to="/app/tables" replace />;
  }
  return children;
}

export const routes: RouteObject[] = [
  { path: '/', element: withSuspenseNoFallback(<LoginPage />) },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      // No home screen: send staff straight to Tables.
      { index: true, element: <AppIndexRedirect /> },
      {
        path: 'clock',
        element: (
          <RequireClockAccess>{withSuspense(<ClockPage />)}</RequireClockAccess>
        ),
      },
      {
        path: 'tables',
        element: (
          <RequirePosAccess>{withSuspense(<TablesPage />)}</RequirePosAccess>
        ),
      },
      {
        path: 'order',
        element: (
          <RequirePosAccess>{withSuspense(<OrderPage />)}</RequirePosAccess>
        ),
      },
      {
        path: 'reports',
        element: (
          <RequirePosAccess>
            <RequireReportsAccess>
              {withSuspense(<ReportsPage />)}
            </RequireReportsAccess>
          </RequirePosAccess>
        ),
      },
      {
        path: 'admin',
        element: <RequireAdmin>{withSuspense(<AdminPage />)}</RequireAdmin>,
      },
    ],
  },
  // Standalone admin shell for separate window
  {
    path: '/admin',
    element: (
      <RequireAdmin>
        <AdminLayout />
      </RequireAdmin>
    ),
    children: [
      { index: true, element: withSuspense(<AdminPage />) },
      { path: 'review', element: withSuspense(<AdminReviewPage />) },
      { path: 'tickets', element: withSuspense(<AdminTicketsPage />) },
      {
        path: 'tickets/:userId',
        element: withSuspense(<AdminUserTicketsPage />),
      },
      { path: 'menu', element: withSuspense(<AdminMenuPage />) },
      { path: 'settings', element: withSuspense(<AdminSettingsPage />) },
    ],
  },
  // Standalone kitchen display window
  {
    path: '/kds',
    element: <RequireKdsAccess>{withSuspense(<KdsPage />)}</RequireKdsAccess>,
  },
  // First-run setup screen for the standalone KDS Electron app.
  {
    path: '/kds-setup',
    element: withSuspense(<KdsSetupPage />),
  },
  // Reservation panel — separate window. Login lives at /reservations,
  // the actual app shell lives at /reservations/app and is gated by RequireHost.
  {
    path: '/reservations',
    element: withSuspenseNoFallback(<ReservationsLoginPage />),
  },
  {
    path: '/reservations/app',
    element: (
      <RequireHost>
        <ReservationsLayout />
      </RequireHost>
    ),
    children: [
      { index: true, element: withSuspense(<ReservationsFloorPage />) },
      { path: 'list', element: withSuspense(<ReservationsListPage />) },
    ],
  },
];
