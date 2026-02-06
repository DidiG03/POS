import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Import shared logic from the Electron app's shared folder (monorepo-style)
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
  },
  server: {
    fs: {
      // Allow importing files from one level up (repo root)
      allow: [path.resolve(__dirname, '..')],
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
    }),
  ],
});
