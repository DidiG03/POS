import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { rendererOptimize, lucideReactAlias } from './vite.rendererOptimize';

const renderer = rendererOptimize();

/**
 * Build configuration for the standalone "OneTap Admin" Electron app.
 *
 * Layout:
 *   dist/admin/
 *     main/index.js         (from src/main/admin/entry.ts)
 *     preload/admin.cjs     (from src/preload/admin.ts)
 *   dist/renderer/          (shared with the POS build)
 *
 * The renderer is the same React app; this main process navigates to
 * `#/admin` or `#/admin-setup`.
 */
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
        '@preload': resolve(__dirname, 'src/preload'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      outDir: 'dist/admin/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/admin/entry.ts'),
        },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
        '@preload': resolve(__dirname, 'src/preload'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      outDir: 'dist/admin/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/admin.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'admin.cjs',
        },
      },
    },
  },
  renderer: {
    esbuild: renderer.esbuild,
    css: renderer.css,
    optimizeDeps: renderer.optimizeDeps,
    resolve: {
      alias: [
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
        { find: '@main', replacement: resolve(__dirname, 'src/main') },
        { find: '@preload', replacement: resolve(__dirname, 'src/preload') },
        { find: '@renderer', replacement: resolve(__dirname, 'src/renderer') },
        lucideReactAlias(),
      ],
    },
    build: {
      ...renderer.build,
      outDir: 'dist/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react(), ...(renderer.plugins ?? [])],
    server: {
      warmup: {
        clientFiles: [
          resolve(__dirname, 'src/renderer/main.tsx'),
          resolve(__dirname, 'src/renderer/routes.tsx'),
          resolve(__dirname, 'src/renderer/app/AdminLayout.tsx'),
          resolve(__dirname, 'src/renderer/app/pages/LoginPage.tsx'),
        ],
      },
    },
  },
});
