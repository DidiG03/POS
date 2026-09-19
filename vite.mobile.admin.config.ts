import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rendererOptimize, lucideReactAlias } from './vite.rendererOptimize';

const renderer = rendererOptimize();

// Vite config for the standalone OneTap Admin Capacitor iOS app.
//
// Output: dist/mobile-admin
//   - dist/mobile-admin/index.html
//   - dist/mobile-admin/assets/*
//
// Same renderer as Waiter / Electron Admin; `VITE_ADMIN_MOBILE_TARGET`
// boots the admin shell (`window.__ADMIN_APP__` + `#/admin` or
// `#/admin-setup`) before the router mounts.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  publicDir: resolve(__dirname, 'public'),
  base: './',
  esbuild: renderer.esbuild,
  css: renderer.css,
  optimizeDeps: renderer.optimizeDeps,
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
      { find: '@db', replacement: resolve(__dirname, 'src/db') },
      { find: '@main', replacement: resolve(__dirname, 'src/main') },
      { find: '@preload', replacement: resolve(__dirname, 'src/preload') },
      { find: '@renderer', replacement: resolve(__dirname, 'src/renderer') },
      lucideReactAlias(),
    ],
  },
  build: {
    ...renderer.build,
    outDir: resolve(__dirname, 'dist/mobile-admin'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
  plugins: [react(), ...(renderer.plugins ?? [])],
  define: {
    'import.meta.env.VITE_MOBILE_TARGET': JSON.stringify('1'),
    'import.meta.env.VITE_ADMIN_MOBILE_TARGET': JSON.stringify('1'),
  },
  server: {
    host: true,
    port: 5175,
    strictPort: true,
    warmup: renderer.server?.warmup,
  },
});
