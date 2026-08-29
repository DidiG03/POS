import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Vitest runs outside electron-vite, so it doesn't inherit the `@shared`,
 * `@db`, `@main`, `@preload`, `@renderer` path aliases defined in
 * `electron.vite.config.ts` / `tsconfig.json`. Mirror them here so unit
 * tests can import source modules the same way the app does.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@db': resolve(__dirname, 'src/db'),
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    // Extend (don't replace) the built-in excludes so nested
    // `**/node_modules/**` (e.g. server/node_modules with bundled zod
    // tests) stay out. Then add our own build/output dirs.
    exclude: [
      ...configDefaults.exclude,
      'tests/**',
      'dist/**',
      'dist-installers/**',
    ],
  },
});
