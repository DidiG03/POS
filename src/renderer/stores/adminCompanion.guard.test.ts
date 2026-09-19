import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function rendererLan(): string {
  return `${read('src/renderer/main.tsx')}\n${read('src/renderer/browserLanApi.ts')}`;
}

describe('standalone Admin companion', () => {
  it('ships a separate Electron entry, builder, and GitHub release workflow', () => {
    expect(read('src/main/admin/entry.ts')).toContain(
      "app.setName('OneTap Admin')",
    );
    expect(read('src/main/admin/entry.ts')).toContain('bustCache');
    expect(read('src/main/admin/entry.ts')).toContain('posHost=');
    expect(read('src/preload/admin.ts')).toContain('__ADMIN_APP__');
    expect(read('src/preload/admin.ts')).toContain('connectHost');
    expect(read('src/preload/admin.ts')).toContain('httpHostForLocalPos');
    expect(read('electron-builder.admin.yml')).toContain('com.codeorbit.admin');
    expect(read('electron-builder.admin.yml')).toContain('channel: admin');
    expect(read('electron-builder.admin.yml')).toContain(
      'OneTap-Admin-${version}-${arch}.${ext}',
    );
    expect(read('electron-builder.kds.yml')).toContain(
      'OneTap-KDS-${version}-${arch}.${ext}',
    );
    expect(read('.github/workflows/release-admin.yml')).toContain('admin-v*');
    expect(read('.github/workflows/release-admin.yml')).toContain(
      'macos-15-intel',
    );
    expect(read('.github/workflows/release-admin.yml')).toContain(
      '--mac --x64',
    );
    expect(read('.github/workflows/release-kds.yml')).toContain(
      'macos-15-intel',
    );
    expect(read('.github/workflows/release-kds.yml')).toContain('--mac --x64');
    expect(read('package.json')).toContain('build:admin');
    expect(read('package.json')).toContain('dist:admin');
  });

  it('lets the Admin app through RequireAdmin and never opens Admin from POS', () => {
    const routes = read('src/renderer/routes.tsx');
    expect(routes).toContain('__ADMIN_APP__');
    expect(routes).toContain('/admin-setup');
    expect(routes).toContain('RequireAdminApp');
    expect(routes).toContain(
      'if (!isAdminApp) return <Navigate to="/" replace />',
    );
    expect(routes).not.toContain("path: 'admin'");
    const main = rendererLan();
    const boot = read('src/renderer/app/BootRoot.tsx');
    expect(boot).toContain('#/admin-setup');
    expect(main).toContain('adminApp?.updater');
    expect(main).toContain("goLan('/admin/updates/status'");
    expect(main).toContain("goLan('/admin/updates/install'");
    expect(main).toContain("goLan('/admin/ticket-counts'");
    expect(main).toContain('/admin/tickets-by-user');
    expect(main).toContain("goLan('/print/scan-network'");
    expect(main).toContain("goLan('/print/test-profile'");
    expect(read('src/main/api.ts')).toContain('syncTableAreasToDb');
    expect(read('src/main/api.ts')).toContain('presentSettingsForClient');
    expect(read('src/main/api.ts')).toContain('updateMenuItemFromInput');
    expect(main).toContain("goLan('/print/list'");
    expect(main).toContain("goLan('/print/serial-ports'");
    expect(main).toContain("goLan('/network/ips'");
    expect(main).toContain("goLan('/backups'");
    expect(main).toContain("goLan('/vault/prefs'");
    expect(main).toContain("goLan('/settings/fiscal-reviews'");
    expect(main).toContain('apps-update');
    expect(read('src/main/api.ts')).toContain('/admin/updates/check');
    expect(read('src/main/services/appUpdates.ts')).toContain(
      'broadcastAppsUpdate',
    );
    expect(read('src/renderer/utils/fleetUpdate.ts')).toContain(
      'prepareFleetUpdates',
    );
    expect(read('src/renderer/utils/adminFleetMenu.ts')).toContain(
      'updater:run-fleet-check',
    );
    expect(read('src/preload/admin.ts')).toContain('updater:run-fleet-check');
    expect(main).not.toContain('admin:openWindow');
    const login = read('src/renderer/app/pages/LoginPage.tsx');
    expect(login).toContain('needsFirstAdmin');
    expect(login).toContain('pos:usersChanged');
    expect(read('src/main/services/realtime.ts')).toContain(
      'broadcastUsersChanged',
    );
    expect(read('src/preload/admin.ts')).toContain('lanFetch');
    expect(read('src/preload/admin.ts')).toContain('lanSseStart');
    expect(read('src/main/admin/entry.ts')).toContain(
      'registerCompanionLanIpc',
    );
    expect(main).toContain('companion.lanFetch');
    expect(main).toContain('backend.connectHost || backend.host');
    expect(main).toContain('/events/login');
    expect(read('src/main/api.ts')).toContain("pathname === '/events/login'");
    expect(read('src/renderer/utils/loginDirectory.ts')).toContain(
      'needsFirstAdmin: isAdminContext && all.length === 0',
    );
    expect(read('src/renderer/utils/loginDirectory.ts')).toContain(
      'emptyDatabase: all.length === 0',
    );
    expect(login).toContain('waitingForAdminSetup');
    expect(read('src/main/api.ts')).toContain('firstAdminBootstrap');
    expect(read('src/main/api.ts')).toContain('authorizeCreateUser');
    expect(read('src/main/services/lanPolicy.ts')).toContain(
      'isFirstAdminLanBootstrap',
    );
    expect(login).toContain('needsPairingCode');
    expect(login).toContain('isBrowserClient && !isAdminApp');
    expect(login).toContain("t('adminLayout.panelTitle')");
    expect(read('src/renderer/app/AdminLayout.tsx')).toContain(
      'hydrateLicenseEditionFromSettings',
    );
    expect(read('src/renderer/app/BootRoot.tsx')).toContain(
      'LicenseEditionSync',
    );
    expect(read('src/renderer/app/BootRoot.tsx')).toContain(
      'hydrateLicenseEditionFromSettings',
    );
    expect(read('src/renderer/app/AdminLayout.tsx')).toContain(
      'pos:forceLogout',
    );
    expect(read('src/renderer/components/DocumentMeta.tsx')).toContain(
      'OneTap Admin',
    );
    expect(login).not.toContain('openPosServerScan');
    expect(login).not.toContain('changeTill');
    expect(login).not.toContain('admin.openWindow');
    expect(login).not.toContain('enableAdmin');
    expect(read('src/renderer/components/BrandMark.tsx')).toContain(
      'const ICON_HOLD_MS = 5000',
    );
    expect(read('src/renderer/app/AdminLayout.tsx')).not.toContain(
      'changeTill',
    );
    const posMain = read('src/main/index.ts');
    expect(posMain).not.toContain('createAdminWindow');
    expect(posMain).not.toContain('admin:openWindow');
    expect(read('src/preload/index.ts')).not.toContain('admin:openWindow');
    expect(read('src/renderer/app/AppLayout.tsx')).not.toContain('openWindow');
    expect(read('src/main/services/ipcPolicy.ts')).not.toContain(
      'admin:openWindow',
    );
  });

  it('ships a separate iOS-only Capacitor Admin target without touching Waiter', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['dev:mobile']).toBe(
      'vite --config vite.mobile.config.ts',
    );
    expect(pkg.scripts['build:mobile']).toBe(
      'vite build --config vite.mobile.config.ts',
    );
    expect(pkg.scripts['cap:sync']).toBe('pnpm build:mobile && cap sync');
    expect(pkg.scripts['cap:run:ios']).toBe('pnpm cap:sync && cap run ios');
    expect(pkg.scripts['dev:mobile:admin']).toBe(
      'vite --config vite.mobile.admin.config.ts',
    );
    expect(pkg.scripts['build:mobile:admin']).toBe(
      'vite build --config vite.mobile.admin.config.ts',
    );
    expect(pkg.scripts['cap:admin:sync']).toContain('capAdmin.mjs sync ios');
    expect(pkg.scripts['cap:admin:open:ios']).toContain(
      'capAdmin.mjs open ios',
    );
    expect(pkg.scripts['cap:admin:run:ios']).toContain('capAdmin.mjs run ios');
    expect(pkg.scripts['cap:admin:sync']).not.toContain('android');

    const capAdmin = read('scripts/capAdmin.mjs');
    expect(capAdmin).toContain("process.env.CAP_APP = 'admin'");
    expect(capAdmin).toContain("'@capacitor'");
    expect(capAdmin).toContain("'cli'");

    const cap = read('capacitor.config.ts');
    expect(cap).toContain("appId: 'com.codeorbit.waiter'");
    expect(cap).toContain("webDir: 'dist/mobile'");
    expect(cap).toContain('adminCapacitorConfig');
    expect(cap).toContain("process.env.CAP_APP === 'admin'");
    expect(cap).not.toContain("path: 'ios-admin'");

    const adminCap = read('capacitor.admin.config.ts');
    expect(adminCap).toContain("appId: 'com.codeorbit.admin'");
    expect(adminCap).toContain("appName: 'OneTap Admin'");
    expect(adminCap).toContain("webDir: 'dist/mobile-admin'");
    expect(adminCap).toContain("path: 'ios-admin'");
    expect(adminCap).toContain("path: 'android-admin'");

    const adminVite = read('vite.mobile.admin.config.ts');
    expect(adminVite).toContain('dist/mobile-admin');
    expect(adminVite).toContain('VITE_MOBILE_TARGET');
    expect(adminVite).toContain('VITE_ADMIN_MOBILE_TARGET');
    expect(read('vite.mobile.config.ts')).not.toContain(
      'VITE_ADMIN_MOBILE_TARGET',
    );

    const main = read('src/renderer/main.tsx');
    expect(main).toContain('VITE_ADMIN_MOBILE_TARGET');
    expect(main).toContain(
      "import { bootAdminMobileShell } from './utils/adminMobileBoot'",
    );
    expect(main).not.toContain("import('./utils/adminMobileBoot')");
    expect(read('src/renderer/utils/adminMobileBoot.ts')).toContain(
      '__ADMIN_APP__',
    );
    expect(read('src/renderer/utils/adminMobileBoot.ts')).toContain(
      '#/admin-setup',
    );
    expect(read('src/renderer/utils/backendHost.ts')).toContain(
      'hydrateCompanionHostFromNativeStore',
    );
    expect(read('src/renderer/utils/backendHost.ts')).toContain(
      'NATIVE_HYDRATE_BUDGET_MS',
    );
    // Cap plugins are thenables; returning Preferences from async unwraps
    // .then() and throws on iOS. Keep a plain { get, set } wrapper.
    expect(read('src/renderer/utils/backendHost.ts')).toContain(
      'get: (opts) => Preferences.get(opts)',
    );
    expect(read('src/renderer/utils/backendHost.ts')).not.toMatch(
      /return Preferences\s*;/,
    );
    expect(read('src/renderer/utils/backendHost.ts')).toContain(
      'companionPersistLocationHash',
    );
    expect(read('src/renderer/app/components/PosServerScan.tsx')).toContain(
      'onConnected?.()',
    );

    const waiterPlist = read('ios/App/App/Info.plist');
    expect(waiterPlist).toContain('OneTap Waiter');
    expect(waiterPlist).not.toContain('OneTap Admin');
    expect(read('ios/App/App.xcodeproj/project.pbxproj')).toContain(
      'PRODUCT_BUNDLE_IDENTIFIER = com.codeorbit.waiter;',
    );
    expect(read('android/app/build.gradle')).toContain('com.codeorbit.waiter');

    const adminPlist = read('ios-admin/App/App/Info.plist');
    expect(adminPlist).toContain('OneTap Admin');
    expect(adminPlist).toContain('NSLocalNetworkUsageDescription');
    expect(adminPlist).toContain('NSBonjourServices');
    expect(adminPlist).toContain('_codeorbit-pos._tcp');
    expect(adminPlist).toContain('NSAllowsLocalNetworking');
    expect(adminPlist).not.toContain('NSAllowsArbitraryLoads');
    expect(read('ios-admin/App/App.xcodeproj/project.pbxproj')).toContain(
      'PRODUCT_BUNDLE_IDENTIFIER = com.codeorbit.admin;',
    );
    expect(read('ios-admin/App/App.xcodeproj/project.pbxproj')).not.toContain(
      'com.codeorbit.waiter',
    );

    expect(fs.existsSync(path.join(root, 'android-admin'))).toBe(false);
  });
});
