import { defineConfig } from '@playwright/test';

export default defineConfig({
  // This file is intentionally kept minimal.
  // The active Playwright config lives at the repo root: `playwright.config.ts`.
  // Keeping this file avoids confusion if someone runs Playwright with an explicit -c tests/playwright.config.ts.
  testDir: '.',
  timeout: 30_000,
  use: {
    viewport: { width: 1280, height: 800 },
  },
});


