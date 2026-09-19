import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { initMobileShell } from './utils/mobileShell';
import i18n, { ensureLocaleResources } from './i18n/config';
import { readStoredPosUiLang, writeStoredPosUiLang } from './i18n/locale';
import { bootPosUiTheme } from './theme';
import { BootRoot } from './app/BootRoot';
import { installPosReadCache } from './utils/posReadCache';
import { installWakeUiRecovery } from './utils/wakeUiRecovery';
import { installUnhandledErrorToasts } from './utils/reportAppError';
import { bootTrace } from '@shared/bootTrace';
// PWA registration disabled for desktop build

void initMobileShell();
if (!(window as any).__KDS_APP__) bootPosUiTheme();

function scheduleIdle(fn: () => void, timeout = 2000) {
  const ric = (
    window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
    }
  ).requestIdleCallback;
  if (typeof ric === 'function') ric(fn, { timeout });
  else setTimeout(fn, 1);
}

function installCompanionUpdaterBridge() {
  const companionUpdater =
    ((window as any).__KDS_APP__ && (window as any).kdsApp?.updater) ||
    ((window as any).__ADMIN_APP__ && (window as any).adminApp?.updater);
  if (companionUpdater) {
    (window as any).api = {
      ...((window as any).api || {}),
      updater: companionUpdater,
    };
  }
}

async function startRenderer() {
  // Capacitor Admin must set `__ADMIN_APP__` and `#/admin` / `#/admin-setup`
  // before BootRoot mounts the hash router. Waiter / Electron skip this.
  // Use a static `import.meta.env.VITE_*` member so Vite `define` replaces
  // it in both `vite build` and `vite dev` (optional chaining is skipped).
  if (import.meta.env.VITE_ADMIN_MOBILE_TARGET) {
    const { bootAdminMobileShell } = await import('./utils/adminMobileBoot');
    await bootAdminMobileShell();
  }

  // Electron preload already defines window.api. Tablets download the LAN
  // HTTP shim only when that bridge is missing so the PIN screen stays small.
  if (!(window as any).api) {
    const { installBrowserLanApi } = await import('./browserLanApi');
    installBrowserLanApi();
  }

  const lng = readStoredPosUiLang();
  await ensureLocaleResources(lng);
  if (i18n.language !== lng) await i18n.changeLanguage(lng);
  writeStoredPosUiLang(lng);

  installPosReadCache();
  installCompanionUpdaterBridge();

  if (typeof window !== 'undefined') {
    bootTrace('renderer:modules');
    installWakeUiRecovery();
    installUnhandledErrorToasts();
    scheduleIdle(() => {
      void import('./utils/remoteAppUpdate').then((m) =>
        m.installRemoteAppUpdateListener(),
      );
      void import('./utils/adminFleetMenu').then((m) =>
        m.installAdminFleetMenuListener(),
      );
    });
  }

  bootTrace('renderer:mount');
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BootRoot />
    </React.StrictMode>,
  );
}

void startRenderer();
