import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { rendererOptimize, lucideReactAlias } from './vite.rendererOptimize';

const renderer = rendererOptimize();

// Vite config used to build the renderer as a plain web app
// for mobile (Capacitor) and PWA distribution.
//
// Output: dist/mobile
//   - dist/mobile/index.html
//   - dist/mobile/assets/*
//
// This config does NOT involve Electron. The renderer's existing
// browser-mode polyfill in src/renderer/main.tsx will speak HTTP
// to the LAN/cloud backend instead of Electron IPC.
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
    outDir: resolve(__dirname, 'dist/mobile'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
  plugins: [react(), ...(renderer.plugins ?? [])],
  define: {
    // Hard-mark this build as a non-Electron browser/mobile target so the
    // renderer's window.api polyfill always activates.
    'import.meta.env.VITE_MOBILE_TARGET': JSON.stringify('1'),
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    warmup: renderer.server?.warmup,
  },
});
