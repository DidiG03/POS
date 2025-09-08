import type { RouteObject } from 'react-router-dom';
import AppLayout from './app/AppLayout';
import LoginPage from './app/pages/LoginPage';
import HomePage from './app/pages/HomePage';
import TablesPage from './app/pages/TablesPage';
import OrderPage from './app/pages/OrderPage';
import ReportsPage from './app/pages/ReportsPage';
import SettingsPage from './app/pages/SettingsPage';
import AdminPage from './app/pages/AdminPage';
import AdminLayout from './app/AdminLayout';
import AdminTicketsPage from './app/pages/AdminTicketsPage';
import AdminUserTicketsPage from './app/pages/AdminUserTicketsPage';
import AdminSettingsPage from './app/pages/AdminSettingsPage';
import React from 'react';
import { useSessionStore } from './stores/session';
import { useEffect } from 'react';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  // If running in browser (not Electron), require an open shift
  const isBrowser = typeof window !== 'undefined' && Boolean((window as any).__BROWSER_CLIENT__);
  const [ok, setOk] = React.useState<boolean>(true);
  useEffect(() => {
    (async () => {
      if (!isBrowser || !user?.id) { setOk(true); return; }
      try {
        const open = await (window as any).api.shifts.getOpen(user.id);
        setOk(Boolean(open));
      } catch {
        setOk(false);
      }
    })();
  }, [isBrowser, user?.id]);
  if (!user) return <LoginPage />;
  if (isBrowser && !ok) return <LoginPage />;
  return children;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  if (!user) return <LoginPage />;
  if (user.role !== 'ADMIN') return <HomePage />;
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
      { index: true, element: <HomePage /> },
      { path: 'tables', element: <TablesPage /> },
      { path: 'order', element: <OrderPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'settings', element: <SettingsPage /> },
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
      { path: 'settings', element: <AdminSettingsPage /> },
    ],
  },
];


