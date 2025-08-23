import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import { routes } from './routes';
import './styles/index.css';
import { offlineQueue } from './utils/offlineQueue';
import { registerSW } from 'virtual:pwa-register';

registerSW();
const router = createHashRouter(routes);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

offlineQueue.sync().catch(() => {});


