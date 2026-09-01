import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CAPACITOR_WEBVIEW_ORIGINS } from '@shared/capacitorWebviewOrigins';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('tablet login bounce guards', () => {
  it('browser shim ignores stale 401s and does not reuse GETs across tokens', () => {
    const src = read('src/renderer/main.tsx');
    expect(src).toContain('shouldForceLogoutOn401');
    expect(src).toContain('lanDedupeKey');
    expect(src).toContain('lanAuthGeneration');
    expect(src).toContain("clearInflight('lan:')");
    expect(src).toContain('SHIFT_GUARD_GRACE_MS');
  });

  it('session persist prefers a live PIN login over empty storage', () => {
    const src = read('src/renderer/stores/session.ts');
    expect(src).toContain('mergeSessionPersist');
    expect(src).toContain('hasHydrated');
    expect(src).toContain('authenticatedAt');
  });

  it('RequireAuth waits for hydration and never swaps Tables for PIN on a missing shift', () => {
    const src = read('src/renderer/routes.tsx');
    expect(src).toContain('shouldDeferShiftGuard');
    expect(src).toContain('hasHydrated');
    expect(src).toContain('needsShift');
    expect(src).toContain('resumeShiftBody');
    expect(src).not.toContain('setOk(false)');
  });

  it('PIN submit waits until session storage has hydrated', () => {
    const src = read('src/renderer/app/pages/LoginPage.tsx');
    expect(src).toContain('hasHydrated');
    expect(src).toContain('disabled={!hasHydrated}');
  });

  it('Android Capacitor serves the app over http and never bakes in a live-reload URL', () => {
    const src = read('capacitor.config.ts');
    expect(src).toContain("androidScheme: 'http'");
    expect(src).toContain('CAP_SERVER_URL');
    expect(src).toMatch(/\.\.\.\(devServerUrl[\s\S]*url: devServerUrl/);
  });

  it('offline queue arms a wake timer after a failed drain', () => {
    const src = read('src/renderer/utils/offlineQueue.ts');
    expect(src).toContain('armWake');
    expect(src).toContain('nextOfflineWakeDelayMs');
  });

  it('SSE broadcast drops dead clients', () => {
    const src = read('src/main/services/realtime.ts');
    expect(src).toContain('writeSseToClients');
    expect(src).toContain('clients.delete(c)');
  });

  it('LAN CORS allows Capacitor WebView origins including Android http://localhost', () => {
    expect(CAPACITOR_WEBVIEW_ORIGINS).toContain('http://localhost');
    expect(CAPACITOR_WEBVIEW_ORIGINS).toContain('http://localhost:8080');
    const api = read('src/main/api.ts');
    expect(api).toContain('CAPACITOR_WEBVIEW_ORIGINS');
  });
});
