import type { RouteObject } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import AppLayout from './app/AppLayout';
import AdminLayout from './app/AdminLayout';
import React from 'react';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { useEffect } from 'react';
import { isClockOnlyRole } from './utils/roles';

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

function withSuspense(el: React.ReactElement) {
  return (
    <React.Suspense fallback={<div className="p-4 opacity-70">Loading…</div>}>
      {el}
    </React.Suspense>
  );
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
    (async () => {
      // KDS clients should be usable without shift clock-in.
      if (!isBrowser || isKdsContext || !user?.id) {
        setOk(true);
        return;
      }
      try {
        const open = await (window as any).api.shifts.getOpen(user.id);
        setOk(Boolean(open));
      } catch {
        setOk(false);
      }
    })();
  }, [isBrowser, isKdsContext, user?.id]);
  if (!user) return withSuspense(<LoginPage />);
  if (isBrowser && !ok) return withSuspense(<LoginPage />);
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  // Admin window uses its own persisted session so it doesn't get overwritten by waiter login.
  const isAdminContext =
    typeof window !== 'undefined' &&
    (window.location.hash || '').startsWith('#/admin');
  // Hooks must not be called conditionally. Read both, then choose.
  const adminUser = useAdminSessionStore((s) => s.user);
  const staffUser = useSessionStore((s) => s.user);
  const user = isAdminContext ? adminUser : staffUser;
  if (!user) return withSuspense(<LoginPage />);
  if (user.role !== 'ADMIN') return withSuspense(<LoginPage />);
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

export const routes: RouteObject[] = [
  { path: '/', element: withSuspense(<LoginPage />) },
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
      { path: 'clock', element: withSuspense(<ClockPage />) },
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
          <RequirePosAccess>{withSuspense(<ReportsPage />)}</RequirePosAccess>
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
    element: withSuspense(<KdsPage />),
  },
];
