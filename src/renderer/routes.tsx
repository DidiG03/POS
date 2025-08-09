import type { RouteObject } from 'react-router-dom';
import AppLayout from './app/AppLayout';
import LoginPage from './app/pages/LoginPage';
import HomePage from './app/pages/HomePage';
import TablesPage from './app/pages/TablesPage';
import OrderPage from './app/pages/OrderPage';
import ReportsPage from './app/pages/ReportsPage';
import SettingsPage from './app/pages/SettingsPage';

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
    ],
  },
];


