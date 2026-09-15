import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
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
    const main = read('src/renderer/main.tsx');
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
    expect(main).toContain("goLan('/settings/fiscal-reviews'");
    expect(main).toContain("goLan('/settings/google-calendar/connect'");
    expect(main).toContain('apps-update');
    expect(read('src/main/api.ts')).toContain('/admin/updates/check');
    expect(read('src/main/services/appUpdates.ts')).toContain(
      'broadcastAppsUpdate',
    );
    expect(read('src/renderer/utils/fleetUpdate.ts')).toContain(
      'installFleetUpdates',
    );
    expect(main).not.toContain('admin:openWindow');
    const login = read('src/renderer/app/pages/LoginPage.tsx');
    expect(login).toContain('isAdminApp');
    expect(login).toContain('needsPairingCode');
    expect(login).toContain('isBrowserClient && !isAdminApp');
    expect(login).toContain("t('adminLayout.panelTitle')");
    expect(read('src/renderer/app/AdminLayout.tsx')).toContain(
      "t('adminLayout.panelTitle')",
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
});
