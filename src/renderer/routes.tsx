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

export const routes: RouteObject[] = [
  { path: '/', element: <LoginPage /> },
  {
    path: '/app',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'tables', element: <TablesPage /> },
      { path: 'order', element: <OrderPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'admin', element: <AdminPage /> },
    ],
  },
  // Standalone admin shell for separate window
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <AdminPage /> },
      { path: 'tickets', element: <AdminTicketsPage /> },
          { path: 'tickets/:userId', element: <AdminUserTicketsPage /> },
      { path: 'settings', element: <AdminSettingsPage /> },
    ],
  },
];


