import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@db': resolve(__dirname, 'src/db'),
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/mobile'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
    },
  },
  define: {
    // Hard-mark this build as a non-Electron browser/mobile target so the
    // renderer's window.api polyfill always activates.
    'import.meta.env.VITE_MOBILE_TARGET': JSON.stringify('1'),
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
  },
});
