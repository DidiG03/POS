import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    viewport: { width: 1280, height: 800 },
  },
  // Avoid conflicts with Vitest expect matchers
  expect: {
    // Use Playwright's own expect matchers
  },
});


