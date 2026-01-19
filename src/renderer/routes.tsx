import type { RouteObject } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import AppLayout from './app/AppLayout';
import LoginPage from './app/pages/LoginPage';
import TablesPage from './app/pages/TablesPage';
import OrderPage from './app/pages/OrderPage';
import ReportsPage from './app/pages/ReportsPage';
import AdminPage from './app/pages/AdminPage';
import AdminLayout from './app/AdminLayout';
import AdminTicketsPage from './app/pages/AdminTicketsPage';
import AdminUserTicketsPage from './app/pages/AdminUserTicketsPage';
import AdminSettingsPage from './app/pages/AdminSettingsPage';
import AdminMenuPage from './app/pages/AdminMenuPage';
import KdsPage from './app/pages/KdsPage';
import React from 'react';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { useEffect } from 'react';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  // If running in browser (not Electron), require an open shift
  const isBrowser = typeof window !== 'undefined' && Boolean((window as any).__BROWSER_CLIENT__);
  const isKdsContext = typeof window !== 'undefined' && (window.location.hash || '').startsWith('#/kds');
  const [ok, setOk] = React.useState<boolean>(true);
  useEffect(() => {
    (async () => {
      // KDS clients should be usable without shift clock-in.
      if (!isBrowser || isKdsContext || !user?.id) { setOk(true); return; }
      try {
        const open = await (window as any).api.shifts.getOpen(user.id);
        setOk(Boolean(open));
      } catch {
        setOk(false);
      }
    })();
  }, [isBrowser, isKdsContext, user?.id]);
  if (!user) return <LoginPage />;
  if (isBrowser && !ok) return <LoginPage />;
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  // Admin window uses its own persisted session so it doesn't get overwritten by waiter login.
  const isAdminContext = typeof window !== 'undefined' && (window.location.hash || '').startsWith('#/admin');
  const user = isAdminContext ? useAdminSessionStore((s) => s.user) : useSessionStore((s) => s.user);
  if (!user) return <LoginPage />;
  if (user.role !== 'ADMIN') return <LoginPage />;
  return children;
}

export const routes: RouteObject[] = [
  { path: '/', element: <LoginPage /> },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      // No home screen: send staff straight to Tables.
      { index: true, element: <Navigate to="tables" replace /> },
      { path: 'tables', element: <TablesPage /> },
      { path: 'order', element: <OrderPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'admin', element: <RequireAdmin><AdminPage /></RequireAdmin> },
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
      { index: true, element: <AdminPage /> },
      { path: 'tickets', element: <AdminTicketsPage /> },
      { path: 'tickets/:userId', element: <AdminUserTicketsPage /> },
      { path: 'menu', element: <AdminMenuPage /> },
      { path: 'settings', element: <AdminSettingsPage /> },
    ],
  },
  // Standalone kitchen display window
  {
    path: '/kds',
    element: <KdsPage />,
  },
];


