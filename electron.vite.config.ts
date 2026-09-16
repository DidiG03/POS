import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { rendererOptimize, lucideReactAlias } from './vite.rendererOptimize';

const renderer = rendererOptimize();

export default defineConfig({
  main: {
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
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/entry.ts'),
        },
        external: [
          '@prisma/client',
          '.prisma/client',
          /\.prisma\/client/,
          '@libsql/client',
          '@prisma/adapter-libsql',
          /^@libsql\//,
          'libsql',
        ],
      },
    },
  },
  preload: {
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
      outDir: 'dist/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
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
        { find: '@db', replacement: resolve(__dirname, 'src/db') },
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
    publicDir: resolve(__dirname, 'public'),
    server: {
      warmup: {
        clientFiles: [
          resolve(__dirname, 'src/renderer/main.tsx'),
          resolve(__dirname, 'src/renderer/routes.tsx'),
          resolve(__dirname, 'src/renderer/app/pages/LoginPage.tsx'),
        ],
      },
    },
  },
});
