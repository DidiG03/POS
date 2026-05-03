import type { RouteObject } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import AppLayout from './app/AppLayout';
import AdminLayout from './app/AdminLayout';
import React from 'react';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { useEffect } from 'react';
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
const KdsPage = React.lazy(() => import('./app/pages/KdsPage'));

function SuspenseFallback() {
  return <PageSpinner message="Loading…" />;
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
  // If running in browser (not Electron), require an open shift
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const isKdsContext =
    typeof window !== 'undefined' &&
    (window.location.hash || '').startsWith('#/kds');
  const [ok, setOk] = React.useState<boolean>(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // KDS clients should be usable without shift clock-in.
      if (!isBrowser || isKdsContext || !user?.id) {
        if (!cancelled) setOk(true);
        return;
      }
      try {
        const open = await (window as any).api.shifts.getOpen(user.id);
        if (!cancelled) setOk(Boolean(open));
      } catch {
        if (!cancelled) setOk(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isBrowser, isKdsContext, user?.id]);
  if (!user) return withSuspenseNoFallback(<LoginPage />);
  if (isBrowser && !ok) return withSuspenseNoFallback(<LoginPage />);
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  // Admin panel is not available on browser/tablet clients
  if (isBrowser) return <Navigate to="/" replace />;
  // Admin window uses its own persisted session so it doesn't get overwritten by waiter login.
  const isAdminContext =
    typeof window !== 'undefined' &&
    (window.location.hash || '').startsWith('#/admin');
  // Hooks must not be called conditionally. Read both, then choose.
  const adminUser = useAdminSessionStore((s) => s.user);
  const staffUser = useSessionStore((s) => s.user);
  const user = isAdminContext ? adminUser : staffUser;
  if (!user) return withSuspenseNoFallback(<LoginPage />);
  if (user.role !== 'ADMIN') return withSuspenseNoFallback(<LoginPage />);
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
function RequireReportsAccess({
  children,
}: {
  children: React.ReactElement;
}) {
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
function RequireKdsAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
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
];
