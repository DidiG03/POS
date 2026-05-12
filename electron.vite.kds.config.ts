import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Build configuration for the standalone "Code Orbit KDS" Electron app.
 *
 * Layout:
 *   dist/kds/
 *     main/index.js         (from src/main/kds/entry.ts)
 *     preload/kds.cjs       (from src/preload/kds.ts)
 *   dist/renderer/          (shared with the POS build)
 *
 * The renderer is intentionally shared with the POS build:
 *   - it's a single React app with hash-routing,
 *   - the KDS main process only navigates to `#/kds` or `#/kds-setup`,
 *   - so we avoid maintaining a second renderer bundle in v1.
 *
 * `electron-builder.kds.yml` packages only the KDS-specific main/preload
 * + the shared renderer + node modules, NOT the POS Prisma client or
 * seed database (configured in the builder file).
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
      outDir: 'dist/kds/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/kds/entry.ts'),
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
      outDir: 'dist/kds/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/kds.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'kds.cjs',
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
        '@preload': resolve(__dirname, 'src/preload'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
  },
});
