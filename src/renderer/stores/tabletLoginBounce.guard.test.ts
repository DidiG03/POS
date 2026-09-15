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
    expect(src).toContain('isPairingRejectedError');
    expect(src).toContain('lanRequestAttempts');
    expect(src).toContain('lanBasesForPath');
    const loginFn = src.slice(
      src.indexOf('async loginWithPin'),
      src.indexOf('async verifyManagerPin'),
    );
    expect(loginFn).toContain("goLan('/auth/login'");
    expect(loginFn).not.toContain("goLan('/pairing/verify'");
    expect(src).toContain("clearInflight('lan:')");
    const boot = read('src/renderer/app/BootRoot.tsx');
    expect(boot).toContain('SHIFT_GUARD_GRACE_MS');
    expect(boot).toContain('sessionShellFromWindow');
    expect(src).toContain("forceLogout('unauthorized')");
    expect(src).toContain("goLan('/notifications?limit=1')");
    expect(read('src/main/services/ipcGuard.ts')).toContain(
      "event.sender.send('auth:forceLogout', { reason: 'unauthorized' })",
    );
  });

  it('session persist prefers a live PIN login over empty storage', () => {
    const src = read('src/renderer/stores/session.ts');
    expect(src).toContain('mergeSessionPersist');
    expect(src).toContain('hasHydrated');
    expect(src).toContain('authenticatedAt');
  });

  it('RequireAuth waits for hydration and never swaps Tables for PIN on a missing shift', () => {
    const src = read('src/renderer/routes.tsx');
    expect(src).toContain('retryLazyImport');
    expect(src).toContain('errorElement');
    expect(src).toContain('shouldDeferShiftGuard');
    expect(src).toContain('hasHydrated');
    expect(src).toContain('needsShift');
    expect(src).toContain('resumeShiftBody');
    expect(src).toContain('resumeMainProcessSession');
    expect(src).toContain('useIpcSessionReady');
    expect(src).not.toContain('setOk(false)');
  });

  it('PIN submit waits until session storage has hydrated', () => {
    const src = read('src/renderer/app/pages/LoginPage.tsx');
    expect(src).toContain('hasHydrated');
    expect(src).toContain('disabled={!hasHydrated}');
    expect(src).toContain('isClockCaptureEnabled');
    expect(src).toContain('invalidateCache(POS_CACHE.settings)');
    expect(src).toContain('applyHostPosUiTheme');
    expect(src).toContain('classifyLanLoginError');
    expect(src).toContain('lanLoginUserMessage');
    expect(src).toContain('peekSettings');
    const loginFn = src.slice(
      src.indexOf('const onSubmit'),
      src.indexOf('const [staff,'),
    );
    expect(loginFn).not.toContain('window.api.settings.get()');
    expect(loginFn).toContain('openIds.includes');
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

  it('tablets catch up after a host update and a dropped SSE socket', () => {
    const main = read('src/renderer/main.tsx');
    const boot = read('src/renderer/app/BootRoot.tsx');
    expect(main).toContain('emitPosSyncCatchup');
    expect(main).toContain('syncTabletToHostVersion');
    expect(main).toContain('installPosRealtimeSync');
    expect(main).toContain('installWakeUiRecovery');
    expect(main).toContain('installUnhandledErrorToasts');
    expect(main).toContain('initRendererSentry');
    expect(boot).toContain('hideMobileSplash');
    expect(main).toContain('POS_BACKEND_HOST_CHANGED');
    expect(main).toContain("addEventListener('catchup'");
    expect(main).toContain("addEventListener('settings'");
    expect(main).toContain('isSseHealthy()');
    expect(read('src/renderer/utils/posReadCache.ts')).toContain(
      'CATCHUP_DEBOUNCE_MS',
    );
    expect(read('src/renderer/utils/posReadCache.ts')).toContain(
      'listCategoriesWithItems',
    );
    expect(read('src/renderer/utils/posReadCache.ts')).not.toContain(
      'void api.settings?.get?.()',
    );
    expect(read('src/renderer/i18n/ThemeSync.tsx')).toContain(
      'applyHostPosUiTheme',
    );
    expect(read('src/renderer/i18n/ThemeSync.tsx')).not.toContain(
      "addEventListener('pos:settingsChanged'",
    );
    expect(read('src/renderer/utils/posReadCache.ts')).toContain(
      'waitIfStale: true',
    );
    expect(read('src/renderer/utils/posRealtimeSync.ts')).toContain(
      'invalidateFloorSnapshots()',
    );
    expect(read('src/renderer/utils/posRealtimeSync.ts')).not.toContain(
      'invalidateFloorCache()',
    );
    expect(read('src/renderer/utils/mobileShell.ts')).toContain(
      'syncNativeChrome',
    );
    const api = read('src/main/api.ts');
    expect(api).toContain('staticAssetCacheControl');
    expect(api).toContain('appVersion: app.getVersion()');
    expect(api).toContain('sseCatchupIfMissed');
    expect(api).toContain("req.headers['last-event-id']");
  });

  it('LAN CORS allows Capacitor WebView origins including Android http://localhost', () => {
    expect(CAPACITOR_WEBVIEW_ORIGINS).toContain('http://localhost');
    expect(CAPACITOR_WEBVIEW_ORIGINS).toContain('http://localhost:8080');
    const api = read('src/main/api.ts');
    expect(api).toContain('CAPACITOR_WEBVIEW_ORIGINS');
  });

  it('Waiter store listing keeps local-network and privacy extras', () => {
    const plist = read('ios/App/App/Info.plist');
    expect(plist).toContain('NSLocalNetworkUsageDescription');
    expect(plist).toContain('NSAllowsLocalNetworking');
    expect(plist).not.toContain('NSAllowsArbitraryLoads');
    expect(plist).toContain('ITSAppUsesNonExemptEncryption');
    const gradle = read('android/app/build.gradle');
    const version = JSON.parse(read('package.json')).version;
    expect(gradle).toContain('com.codeorbit.waiter');
    expect(gradle).toContain(`versionName "${version}"`);
    const listing = JSON.parse(read('store/en.json'));
    expect(listing.bundleId).toBe('com.codeorbit.waiter');
    expect(read('public/legal/privacy.html')).toContain('Privacy Policy');
    expect(read('public/legal/support.html')).toContain('same Wi-Fi');
  });
});
