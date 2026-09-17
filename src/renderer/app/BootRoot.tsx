import React, { useEffect, useState } from 'react';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { routes } from '../routes';
import { offlineQueue } from '../utils/offlineQueue';
import { useSessionStore } from '../stores/session';
import { useAdminSessionStore } from '../stores/adminSession';
import { useReservationSessionStore } from '../stores/reservationSession';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { hideMobileSplash } from '../utils/mobileShell';
import { resumeMainProcessSession } from '../utils/resumeSession';
import i18n from '../i18n/config';
import { LocaleSync } from '../i18n/LocaleSync';
import { ThemeSync } from '../i18n/ThemeSync';
import { PageSpinner } from '../components/PageSpinner';
import { useLicenseCapabilities } from '../stores/licenseCapabilities';
import { hydrateLicenseEditionFromSettings } from '../utils/hydrateLicenseEdition';
import { readStoredFlag, writeStoredFlag } from '../utils/storedFlag';
import { VaultGate } from './components/VaultGate';
import {
  hasConfiguredBackendHost,
  resolveBackendHost,
} from '../utils/backendHost';
import { peekSettings } from '../utils/posReadCache';
import {
  POS_BACKEND_HOST_CHANGED,
  POS_OPEN_SERVER_SCAN,
} from '../utils/posServerScanEvent';
import {
  SHIFT_GUARD_GRACE_MS,
  isPersistedSessionExpired,
  sessionShellFromWindow,
} from '../stores/sessionPersist';
import { syncTabletToHostVersion } from '../utils/syncTabletToHostVersion';
import { bootTrace } from '@shared/bootTrace';

const router = createHashRouter(routes);

const LicenseGate = React.lazy(() => import('./components/LicenseGate'));
const UpdateNotification = React.lazy(() =>
  import('../components/UpdateNotification').then((m) => ({
    default: m.UpdateNotification,
  })),
);
const Toaster = React.lazy(() =>
  import('../components/Toaster').then((m) => ({ default: m.Toaster })),
);
const PosServerScanPanel = React.lazy(() =>
  import('./components/PosServerScan').then((m) => ({
    default: m.PosServerScanPanel,
  })),
);
const PosServerScanOverlay = React.lazy(() =>
  import('./components/PosServerScan').then((m) => ({
    default: m.PosServerScanOverlay,
  })),
);

const LICENSE_OK_KEY = 'pos-license-ok';

function isElectronLicenseHost(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).api?.license) &&
    !(window as any).__BROWSER_CLIENT__ &&
    !(window as any).__KDS_APP__ &&
    !(window as any).__ADMIN_APP__
  );
}

function MaybeLicenseGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const host = isElectronLicenseHost();
  const [blocked, setBlocked] = useState(
    () => host && !readStoredFlag(LICENSE_OK_KEY, true),
  );

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void window.api.license
      .getStatus()
      .then((s) => {
        if (cancelled) return;
        const ok = !s?.required || Boolean(s?.licensed);
        writeStoredFlag(LICENSE_OK_KEY, ok);
        useLicenseCapabilities.getState().setEdition(s?.edition);
        setBlocked(!ok);
      })
      .catch(() => {
        // Keep the last known edition; a failed status check must not
        // flip a store till onto restaurant defaults.
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!host || !blocked) return <>{children}</>;
  return (
    <React.Suspense fallback={<PageSpinner message={t('common.loading')} />}>
      <LicenseGate>{children}</LicenseGate>
    </React.Suspense>
  );
}

function LicenseEditionSync() {
  useEffect(() => {
    let cancelled = false;
    void window.api?.settings
      ?.get?.()
      .then((s: { licenseEdition?: string | null } | null) => {
        if (!cancelled) hydrateLicenseEditionFromSettings(s);
      })
      .catch(() => {
        // Leave the current edition in place if the till is unreachable.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function BootScreen({
  message,
  detail,
  showScan,
}: {
  message: string;
  detail?: string;
  showScan?: boolean;
}) {
  return (
    <PageSpinner
      message={message}
      detail={showScan ? undefined : detail}
      spinner={!showScan}
    >
      {showScan ? (
        <React.Suspense fallback={null}>
          <PosServerScanPanel autoScan />
        </React.Suspense>
      ) : null}
    </PageSpinner>
  );
}

function Root() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState(() => t('boot.starting'));
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const [hostEpoch, setHostEpoch] = useState(0);

  useEffect(() => {
    const onHost = () => setHostEpoch((n) => n + 1);
    window.addEventListener(POS_BACKEND_HOST_CHANGED, onHost);
    return () => window.removeEventListener(POS_BACKEND_HOST_CHANGED, onHost);
  }, []);

  useEffect(() => {
    if (ready || backendUnreachable) void hideMobileSplash();
  }, [ready, backendUnreachable]);

  useEffect(() => {
    const onForce = (ev: any) => {
      const reason = ev?.detail?.reason
        ? String(ev.detail.reason)
        : t('boot.sessionExpired');
      const shell = sessionShellFromWindow(window?.location?.hash || '', {
        adminApp: Boolean((window as any).__ADMIN_APP__),
      });
      // Clear only the session store that belongs to this window. POS, Admin,
      // and Reservations share one origin / localStorage; wiping all three
      // here is what kicked an admin PIN login back to the login screen
      // whenever a leftover waiter session expired.
      try {
        if (shell === 'admin') {
          useAdminSessionStore.getState().setUser(null as any);
        } else if (shell === 'reservations') {
          useReservationSessionStore.getState().setUser(null as any);
        } else {
          useSessionStore.getState().setUser(null);
        }
      } catch {
        // ignore
      }
      try {
        window.location.hash =
          shell === 'admin'
            ? '#/admin'
            : shell === 'reservations'
              ? '#/reservations'
              : '#/';
      } catch {
        // ignore
      }
      // Optional: show a short hint on boot screen (if it appears)
      setMsg(t('boot.loginAgain'));
      setDetail(reason);
    };
    window.addEventListener('pos:forceLogout', onForce as any);
    return () => window.removeEventListener('pos:forceLogout', onForce as any);
  }, [t]);

  useEffect(() => {
    // Session expiry for Electron (persisted zustand sessions).
    // Browser clients already rely on API token expiry; they will trigger pos:forceLogout on 401.
    const tick = () => {
      if (!useSessionStore.getState().hasHydrated) return;
      const shell = sessionShellFromWindow(window?.location?.hash || '', {
        adminApp: Boolean((window as any).__ADMIN_APP__),
      });
      const now = Date.now();
      const staff = useSessionStore.getState() as any;
      const admin = useAdminSessionStore.getState() as any;
      const reservations = useReservationSessionStore.getState() as any;
      const staffGraceUntil =
        typeof staff?.authenticatedAt === 'number' && staff.authenticatedAt > 0
          ? staff.authenticatedAt + SHIFT_GUARD_GRACE_MS
          : undefined;
      const expired =
        shell === 'admin'
          ? isPersistedSessionExpired({
              user: admin?.user,
              expiresAtMs: admin?.expiresAtMs,
              now,
            })
          : shell === 'reservations'
            ? isPersistedSessionExpired({
                user: reservations?.user,
                expiresAtMs: reservations?.expiresAtMs,
                now,
              })
            : isPersistedSessionExpired({
                user: staff?.user,
                expiresAtMs: staff?.expiresAtMs,
                now,
                graceUntilMs: staffGraceUntil,
              });
      if (!expired) return;
      try {
        window.dispatchEvent(
          new CustomEvent('pos:forceLogout', {
            detail: { reason: t('boot.sessionExpired') },
          }),
        );
      } catch {
        // ignore
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const isKdsApp = Boolean((window as any).__KDS_APP__);
      const isAdminApp = Boolean((window as any).__ADMIN_APP__);
      const isCompanionApp = isKdsApp || isAdminApp;
      const hash = String(window.location.hash || '');
      const onCompanionSetup =
        (isKdsApp && hash.startsWith('#/kds-setup')) ||
        (isAdminApp && hash.startsWith('#/admin-setup'));
      if (onCompanionSetup) {
        setReady(true);
        return;
      }

      setReady(false);
      setBackendUnreachable(false);
      setMsg(t('boot.connecting'));
      setDetail(undefined);
      bootTrace('boot:connecting');
      if (!isCompanionApp && !hasConfiguredBackendHost()) {
        setBackendUnreachable(true);
        setMsg(t('boot.cannotReach'));
        setDetail(t('boot.cannotReachDetail'));
        return;
      }
      const cachedSettings = !isCompanionApp ? peekSettings() : undefined;
      if (cachedSettings) {
        await resumeMainProcessSession().catch(() => {});
        if (cancelled) return;
        setReady(true);
        bootTrace('boot:ready (cached settings)');
        setBackendUnreachable(false);
        setMsg(t('boot.starting'));
        setDetail(undefined);
        void Promise.all([
          (window as any).api.settings.get().catch(() => null),
          (window as any).api.auth.listUsers().catch(() => null),
        ]).then(() => {
          if (!cancelled) offlineQueue.sync().catch(() => {});
        });
        void syncTabletToHostVersion();
        return;
      }
      const maxAttempts = 2;
      // One extra attempt, then stop so the user can Scan. No retry button.
      for (let attempt = 0; attempt < maxAttempts && !cancelled; attempt++) {
        try {
          // Android tablets (Samsung especially) often report navigator.onLine
          // false until the OS "validates" internet access — LAN-only setups
          // never satisfy that check, which blocks POS before fetch() runs.
          const capacitor =
            typeof window !== 'undefined' ? (window as any).Capacitor : null;
          const isNativeCaps =
            Boolean(capacitor?.isNativePlatform?.()) ||
            Boolean(
              capacitor?.getPlatform?.() && capacitor.getPlatform() !== 'web',
            );
          if (
            !isNativeCaps &&
            typeof navigator !== 'undefined' &&
            navigator.onLine === false
          ) {
            setMsg(t('boot.offline'));
            setDetail(t('boot.offlineDetail'));
            await sleep(750);
            continue;
          }
          // Minimal "backend is ready" checks. Companions probe the host;
          // the till needs settings. The staff directory loads on the login screen.
          if (isCompanionApp) {
            const companion = ((window as any).adminApp ||
              (window as any).kdsApp) as
              | {
                  testConnection?: (input: {
                    host: string;
                    httpPort: number;
                  }) => Promise<{ ok: boolean; error?: string }>;
                }
              | undefined;
            const backend = resolveBackendHost();
            if (companion?.testConnection) {
              const r = await companion.testConnection({
                host: backend.host,
                httpPort: Number(backend.httpPort) || 3333,
              });
              if (!r.ok) throw new Error(r.error || 'POS host unreachable');
            } else if (isKdsApp) {
              await (window as any).api.kds.debug();
            } else {
              await (window as any).api.health.ping();
            }
          } else {
            await (window as any).api.settings.get();
            void (window as any).api.auth.listUsers().catch(() => null);
            void syncTabletToHostVersion();
          }
          if (cancelled) return;
          // Hand the main process the token from our last login so it can
          // recognise the persisted session as one it issued. Without this the
          // privileged IPC channels stay closed after an app restart.
          await resumeMainProcessSession().catch(() => {});
          if (cancelled) return;
          setReady(true);
          bootTrace('boot:ready');
          setBackendUnreachable(false);
          setMsg(t('boot.starting'));
          setDetail(undefined);
          // After backend is confirmed, run offline sync (safe for Electron + browser)
          offlineQueue.sync().catch(() => {});
          return;
        } catch (e: any) {
          void e;
          if (attempt + 1 < maxAttempts && !cancelled) {
            await sleep(400);
          }
        }
      }
      if (!cancelled) {
        const isKdsApp = Boolean((window as any).__KDS_APP__);
        const isAdminApp = Boolean((window as any).__ADMIN_APP__);
        if (isKdsApp || isAdminApp) {
          try {
            window.location.hash = isAdminApp ? '#/admin-setup' : '#/kds-setup';
          } catch {
            // ignore
          }
          setReady(true);
          return;
        }
        setBackendUnreachable(true);
        setMsg(t('boot.cannotReach'));
        setDetail(t('boot.cannotReachDetail'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t, hostEpoch]);

  if (!ready) {
    const lanClient =
      Boolean((window as any).__BROWSER_CLIENT__) ||
      Boolean((window as any).__KDS_APP__) ||
      Boolean((window as any).__ADMIN_APP__);
    const showScan = backendUnreachable && lanClient;
    return (
      <BootScreen
        message={msg}
        detail={showScan ? undefined : detail}
        showScan={showScan}
      />
    );
  }
  return (
    <>
      <RouterProvider router={router} />
      {(window as any).__KDS_APP__ || (window as any).__ADMIN_APP__ ? (
        <React.Suspense fallback={null}>
          <UpdateNotification />
        </React.Suspense>
      ) : null}
    </>
  );
}

function PosServerScanHostGate() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(POS_OPEN_SERVER_SCAN, onOpen);
    return () => window.removeEventListener(POS_OPEN_SERVER_SCAN, onOpen);
  }, []);
  if (!open) return null;
  return (
    <React.Suspense fallback={null}>
      <PosServerScanOverlay onClose={() => setOpen(false)} />
    </React.Suspense>
  );
}

export function BootRoot() {
  return (
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary>
        <VaultGate>
          <LocaleSync>
            <ThemeSync>
              <MaybeLicenseGate>
                <LicenseEditionSync />
                <Root />
              </MaybeLicenseGate>
              <PosServerScanHostGate />
              <React.Suspense fallback={null}>
                <Toaster />
              </React.Suspense>
            </ThemeSync>
          </LocaleSync>
        </VaultGate>
      </ErrorBoundary>
    </I18nextProvider>
  );
}
