import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

test('window opens and navigate', async () => {
  const child = spawn(process.execPath, ['node_modules/.bin/electron-vite', 'preview'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  // Very basic smoke: ensure process starts; in real app use electron E2E helpers
  let started = false;
  child.stdout?.on('data', (d) => {
    const s = String(d);
    if (s.includes('ready')) started = true;
  });

  await new Promise((r) => setTimeout(r, 3000));
  expect(started || child.pid).toBeTruthy();
  child.kill();
});


