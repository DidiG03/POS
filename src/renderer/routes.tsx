import type { RouteObject } from 'react-router-dom';
import { Navigate, useRouteError } from 'react-router-dom';
import React, { useEffect } from 'react';
import { useSessionStore } from './stores/session';
import { useAdminSessionStore } from './stores/adminSession';
import { useReservationSessionStore } from './stores/reservationSession';
import { useLicenseCapabilities } from './stores/licenseCapabilities';
import { staffPosHomePath } from '@shared/editionCapabilities';
import { useKdsOrdersAccess } from './app/useKdsOrdersAccess';
import { useTranslation } from 'react-i18next';
import {
  isClockOnlyRole,
  canSeeReportsOnMobile,
  canSeeKdsOnMobile,
} from '@shared/utils/roles';
import { isHostOrAdminRole, jwtRole } from '@shared/jwtRole';
import { PageSpinner } from './components/PageSpinner';
import { shouldDeferShiftGuard } from './stores/sessionPersist';
import { isClockCaptureEnabled } from '@shared/clockCapture';
import { clockCaptureFromChange } from '@shared/settingsChange';
import { resumeMainProcessSession } from './utils/resumeSession';
import { Button } from './components/ui/Button';
import { isChunkLoadError, retryLazyImport } from './utils/lazyRetry';

function lazyPage<T extends { default: React.ComponentType<any> }>(
  importer: () => Promise<T>,
) {
  return React.lazy(() => retryLazyImport(importer));
}

const LoginPage = lazyPage(() => import('./app/pages/LoginPage'));
const AppLayout = lazyPage(() => import('./app/AppLayout'));
const AdminLayout = lazyPage(() => import('./app/AdminLayout'));
const ReservationsLayout = lazyPage(() => import('./app/ReservationsLayout'));
const ConfirmDialog = lazyPage(() =>
  import('./components/ui/Modal').then((m) => ({ default: m.ConfirmDialog })),
);
const TablesPage = lazyPage(() => import('./app/pages/TablesPage'));
const OrderPage = lazyPage(() => import('./app/pages/OrderPage'));
const ReportsPage = lazyPage(() => import('./app/pages/ReportsPage'));
const WaiterOrdersPage = lazyPage(() => import('./app/pages/WaiterOrdersPage'));
const NotificationsPage = lazyPage(
  () => import('./app/pages/NotificationsPage'),
);
const ClockPage = lazyPage(() => import('./app/pages/ClockPage'));
const AdminPage = lazyPage(() => import('./app/pages/AdminPage'));
const AdminTicketsPage = lazyPage(() => import('./app/pages/AdminTicketsPage'));
const AdminUserTicketsPage = lazyPage(
  () => import('./app/pages/AdminUserTicketsPage'),
);
const AdminSettingsPage = lazyPage(
  () => import('./app/pages/AdminSettingsPage'),
);
const AdminMenuPage = lazyPage(() => import('./app/pages/AdminMenuPage'));
const AdminStockPage = lazyPage(() => import('./app/pages/AdminStockPage'));
const AdminReviewPage = lazyPage(() => import('./app/pages/AdminReviewPage'));
const KdsPage = lazyPage(() => import('./app/pages/KdsPage'));
const KdsSetupPage = lazyPage(() => import('./app/pages/KdsSetupPage'));
const AdminSetupPage = lazyPage(() => import('./app/pages/AdminSetupPage'));
const ReservationsLoginPage = lazyPage(
  () => import('./app/pages/ReservationsLoginPage'),
);
const ReservationsFloorPage = lazyPage(
  () => import('./app/pages/ReservationsFloorPage'),
);
const ReservationsListPage = lazyPage(
  () => import('./app/pages/ReservationsListPage'),
);

function RouteErrorPage() {
  const err = useRouteError();
  const { t } = useTranslation();
  const chunk = isChunkLoadError(err);
  useEffect(() => {
    if (!chunk) return;
    const id = window.setTimeout(() => window.location.reload(), 450);
    return () => window.clearTimeout(id);
  }, [chunk]);
  return (
    <PageSpinner
      message={chunk ? t('boot.reloadChunk') : t('common.toastError')}
      spinner={chunk}
    >
      {chunk ? null : (
        <Button variant="primary" onClick={() => window.location.reload()}>
          {t('routes.reload')}
        </Button>
      )}
    </PageSpinner>
  );
}

function withRouteError(route: RouteObject): RouteObject {
  return { errorElement: <RouteErrorPage />, ...route };
}

function SuspenseFallback() {
  const { t } = useTranslation();
  return <PageSpinner message={t('routes.loading')} />;
}

function withSuspense(el: React.ReactElement) {
  return <React.Suspense fallback={<SuspenseFallback />}>{el}</React.Suspense>;
}

function withSuspenseNoFallback(el: React.ReactElement) {
  // Used for screens that already render their own boot/loading UI (e.g. LoginPage).
  return <React.Suspense fallback={null}>{el}</React.Suspense>;
}

/**
 * Privileged IPC is bound to this window's sender id. A persisted Zustand
 * user is not enough: after restart / HMR the till can paint Tables while
 * main still has no session, which floods `ipc_denied`. Wait until the
 * token is rebound (or there is nothing to bind).
 */
function useIpcSessionReady(needsBind: boolean): boolean {
  const [bound, setBound] = React.useState(false);
  useEffect(() => {
    if (!needsBind) {
      setBound(false);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let retry: number | null = null;
    const run = () => {
      void resumeMainProcessSession().then((ok) => {
        if (cancelled) return;
        if (ok || attempts >= 8) {
          setBound(true);
          return;
        }
        attempts += 1;
        retry = window.setTimeout(run, 300);
      });
    };
    run();
    return () => {
      cancelled = true;
      if (retry != null) window.clearTimeout(retry);
    };
  }, [needsBind]);
  return !needsBind || bound;
}

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { t } = useTranslation();
  const user = useSessionStore((s) => s.user);
  const sessionToken = useSessionStore((s) => s.sessionToken);
  const hasHydrated = useSessionStore((s) => s.hasHydrated);
  const authenticatedAt = useSessionStore((s) => s.authenticatedAt);
  // If running in browser (not Electron), require an open shift. This catches
  // the case where a persisted Zustand session (across page reloads) outlives
  // the actual shift — without this guard a clocked-out staffer could resume
  // POS access just by reopening the tab.
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const isKdsContext =
    typeof window !== 'undefined' &&
    (window.location.hash || '').startsWith('#/kds');
  const ipcReady = useIpcSessionReady(
    Boolean(user && sessionToken && !isBrowser),
  );
  const clockOnly = Boolean(user && isClockOnlyRole((user as any).role));
  // Keep the waiter on the floor. A missing shift used to swap in LoginPage
  // while the JWT was still live, which bounced PIN → Tables → PIN.
  const [needsShift, setNeedsShift] = React.useState(false);
  const [shiftBusy, setShiftBusy] = React.useState(false);
  const [settingsTick, setSettingsTick] = React.useState(0);
  useEffect(() => {
    const bump = (ev: Event) => {
      if (ev.type === 'pos:settingsChanged') {
        const clock = clockCaptureFromChange((ev as CustomEvent).detail);
        if (clock === false) setNeedsShift(false);
      }
      setSettingsTick((n) => n + 1);
    };
    window.addEventListener('pos:settingsChanged', bump);
    return () => window.removeEventListener('pos:settingsChanged', bump);
  }, []);
  useEffect(() => {
    const userId = user?.id;
    if (
      shouldDeferShiftGuard({
        hasHydrated,
        isBrowser,
        isKdsContext,
        userId,
        authenticatedAt,
      })
    ) {
      setNeedsShift(false);
      return;
    }
    if (!userId) {
      setNeedsShift(false);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let retryTimer: number | null = null;
    const check = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const settings = await (window as any).api.settings
          .get()
          .catch(() => null);
        // A failed or empty settings read must not assume clock-in is on.
        if (settings == null || !isClockCaptureEnabled(settings)) {
          if (!cancelled) setNeedsShift(false);
          return;
        }
        const open = await (window as any).api.shifts.getOpen(userId);
        if (cancelled) return;
        if (open) {
          setNeedsShift(false);
          return;
        }
        if (attempts < 4) {
          attempts += 1;
          retryTimer = window.setTimeout(check, 500);
          return;
        }
        // Clock-only roles already sit on /app/clock. Waiters keep Tables
        // and get a start-shift prompt instead of the PIN screen.
        setNeedsShift(!clockOnly);
      } catch {
        if (!cancelled) setNeedsShift(false);
      }
    };
    void check();
    return () => {
      cancelled = true;
      // Staff log in and out all shift; leaving these to fire keeps waking a
      // terminal that runs for weeks without a restart.
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [
    isBrowser,
    isKdsContext,
    user?.id,
    hasHydrated,
    authenticatedAt,
    clockOnly,
    settingsTick,
  ]);
  if (!hasHydrated) return <SuspenseFallback />;
  if (!user) return withSuspenseNoFallback(<LoginPage />);
  if (!ipcReady) return <SuspenseFallback />;
  return (
    <>
      {children}
      {isBrowser && needsShift ? (
        <React.Suspense fallback={null}>
          <ConfirmDialog
            open
            title={t('login.startShiftTitle', { name: user.displayName })}
            body={t('login.resumeShiftBody')}
            confirmLabel={t('common.confirm')}
            cancelLabel={t('common.cancel')}
            busy={shiftBusy}
            onConfirm={() => {
              void (async () => {
                setShiftBusy(true);
                try {
                  await (window as any).api.shifts.clockIn(user.id);
                  setNeedsShift(false);
                } catch {
                  // Stay on the prompt; PIN bounce is worse than a retry.
                } finally {
                  setShiftBusy(false);
                }
              })();
            }}
            onCancel={() => {
              try {
                window.dispatchEvent(
                  new CustomEvent('pos:forceLogout', {
                    detail: { reason: t('login.notClockedIn') },
                  }),
                );
              } catch {
                // ignore
              }
            }}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  // CORRECTNESS: Hooks MUST be called unconditionally and in the same order
  // every render. Read both stores at the top, then make routing decisions
  // afterward. (Previously these hooks lived after an early return, which
  // tripped react-hooks/rules-of-hooks.)
  const adminUser = useAdminSessionStore((s) => s.user);
  const isAdminApp =
    typeof window !== 'undefined' && Boolean((window as any).__ADMIN_APP__);
  // POS / tablets never host the back office. Only the standalone OneTap
  // Admin app (LAN companion) may render these routes. That app talks HTTP,
  // so there is no POS IPC session to wait for.
  if (!isAdminApp) return <Navigate to="/" replace />;
  if (!adminUser) return withSuspenseNoFallback(<LoginPage />);
  if (adminUser.role !== 'ADMIN') return withSuspenseNoFallback(<LoginPage />);
  return children;
}

function RequireAdminApp({ children }: { children: React.ReactElement }) {
  const isAdminApp =
    typeof window !== 'undefined' && Boolean((window as any).__ADMIN_APP__);
  if (!isAdminApp) return <Navigate to="/" replace />;
  return children;
}

function browserHostTokenOk(): boolean {
  if (typeof window === 'undefined' || !(window as any).__BROWSER_CLIENT__) {
    return true;
  }
  try {
    const host = localStorage.getItem('pos_host_api_token');
    if (host && isHostOrAdminRole(jwtRole(host))) return true;
    const shared = localStorage.getItem('pos_api_token');
    return Boolean(shared && isHostOrAdminRole(jwtRole(shared)));
  } catch {
    return true;
  }
}

function RequireHost({ children }: { children: React.ReactElement }) {
  // Hooks first — same rationale as RequireAdmin (no conditional hooks).
  // The reservation panel runs in two shells: the dedicated Electron window
  // on the desktop, and the same SPA bundle inside Capacitor / mobile
  // browsers. We intentionally do NOT block browser clients here — hosts
  // need to manage reservations from their phones.
  const reservationUser = useReservationSessionStore((s) => s.user);
  const reservationExpires = useReservationSessionStore((s) => s.expiresAtMs);
  // Honor the session TTL so a stale session doesn't silently grant access.
  const expired =
    typeof reservationExpires === 'number' &&
    reservationExpires > 0 &&
    reservationExpires < Date.now();
  if (!reservationUser || expired) {
    return <Navigate to="/reservations" replace />;
  }
  const role = String((reservationUser as any).role || '').toUpperCase();
  if (role !== 'HOST' && role !== 'ADMIN') {
    return <Navigate to="/reservations" replace />;
  }
  // Tablets share one origin with the waiter app. A waiter PIN overwrites
  // `pos_api_token`, so a still-persisted host session would otherwise call
  // merge/save as WAITER and get 403 Forbidden.
  if (!browserHostTokenOk()) {
    return <Navigate to="/reservations" replace />;
  }
  return children;
}

function RequireReservations({ children }: { children: React.ReactElement }) {
  const hydrated = useLicenseCapabilities((s) => s.hydrated);
  const hasReservations = useLicenseCapabilities((s) => s.hasReservations);
  if (!hydrated) return <SuspenseFallback />;
  if (!hasReservations) return <Navigate to="/" replace />;
  return children;
}

function useStaffPosHome() {
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  return staffPosHomePath({ hasTables });
}

function AppIndexRedirect() {
  const user = useSessionStore((s) => s.user);
  const hydrated = useLicenseCapabilities((s) => s.hydrated);
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  if (!user) return <Navigate to="/" replace />;
  if (!hydrated) return <SuspenseFallback />;
  if (isClockOnlyRole((user as any).role)) {
    return <Navigate to="clock" replace />;
  }
  return <Navigate to={hasTables ? 'tables' : 'order'} replace />;
}

function RequirePosAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  if (!user) return <Navigate to="/" replace />;
  if (isClockOnlyRole((user as any).role))
    return <Navigate to="/app/clock" replace />;
  return children;
}

function RequireTables({ children }: { children: React.ReactElement }) {
  const hydrated = useLicenseCapabilities((s) => s.hydrated);
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  if (!hydrated) return <SuspenseFallback />;
  if (!hasTables) return <Navigate to="/app/order" replace />;
  return children;
}

function RequireClockAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  const staffHome = useStaffPosHome();
  if (!user) return <Navigate to="/" replace />;
  // Requirement: waiters must NOT see/use the Clock page.
  if (String((user as any)?.role || '').toUpperCase() === 'WAITER') {
    return <Navigate to={staffHome} replace />;
  }
  return children;
}

// On mobile (Capacitor / browser shell) only ADMIN and CASHIER may see
// the Reports screen. Other roles get redirected to Tables. The Electron
// desktop is unrestricted because admins use it for back-office work.
function RequireReportsAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  const staffHome = useStaffPosHome();
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  if (!user) return <Navigate to="/" replace />;
  if (isBrowser && !canSeeReportsOnMobile((user as any).role)) {
    return <Navigate to={staffHome} replace />;
  }
  return children;
}

function RequireKdsOrdersAccess({
  children,
}: {
  children: React.ReactElement;
}) {
  const user = useSessionStore((s) => s.user);
  const staffHome = useStaffPosHome();
  const access = useKdsOrdersAccess();
  if (!user) return <Navigate to="/" replace />;
  if (access === 'loading') return <SuspenseFallback />;
  if (access === 'no') return <Navigate to={staffHome} replace />;
  return children;
}

// KDS is kitchen staff on a restaurant license. Store POS redirects away.
// On mobile, restrict to kitchen roles so a waiter who pastes a /kds deep
// link doesn't end up on a screen they can't act on.
//
// The standalone "OneTap KDS" Electron app sets `__KDS_APP__ = true`
// from its preload — that build is a kitchen-only kiosk so we skip the
// login/role/edition gate. A store till still rejects KDS over LAN.
function RequireKdsAccess({ children }: { children: React.ReactElement }) {
  const user = useSessionStore((s) => s.user);
  const hydrated = useLicenseCapabilities((s) => s.hydrated);
  const hasKds = useLicenseCapabilities((s) => s.hasKds);
  const staffHome = useStaffPosHome();
  const isKdsApp =
    typeof window !== 'undefined' && Boolean((window as any).__KDS_APP__);
  const isBrowser =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  // The standalone kitchen kiosk is a different app; it talks to a restaurant
  // host over LAN. Store POS itself must not open a kitchen screen.
  if (isKdsApp) return children;
  if (!hydrated) return <SuspenseFallback />;
  if (!hasKds) return <Navigate to={user ? staffHome : '/'} replace />;
  if (!isBrowser) return children;
  if (!user) return <Navigate to="/" replace />;
  if (!canSeeKdsOnMobile((user as any).role)) {
    return <Navigate to={staffHome} replace />;
  }
  return children;
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: withSuspenseNoFallback(<LoginPage />),
  },
  {
    path: '/app',
    element: <RequireAuth>{withSuspense(<AppLayout />)}</RequireAuth>,
    children: [
      // No home screen: restaurant → tables, store → till sale.
      { index: true, element: <AppIndexRedirect /> },
      {
        path: 'clock',
        element: (
          <RequireClockAccess>{withSuspense(<ClockPage />)}</RequireClockAccess>
        ),
      },
      {
        path: 'tables',
        element: (
          <RequirePosAccess>
            <RequireTables>{withSuspense(<TablesPage />)}</RequireTables>
          </RequirePosAccess>
        ),
      },
      {
        path: 'notifications',
        element: withSuspense(<NotificationsPage />),
      },
      {
        path: 'order',
        element: (
          <RequirePosAccess>{withSuspense(<OrderPage />)}</RequirePosAccess>
        ),
      },
      {
        path: 'reports',
        element: (
          <RequirePosAccess>
            <RequireReportsAccess>
              {withSuspense(<ReportsPage />)}
            </RequireReportsAccess>
          </RequirePosAccess>
        ),
      },
      {
        path: 'orders',
        element: (
          <RequirePosAccess>
            <RequireKdsOrdersAccess>
              {withSuspense(<WaiterOrdersPage />)}
            </RequireKdsOrdersAccess>
          </RequirePosAccess>
        ),
      },
    ],
  },
  // Standalone admin shell — OneTap Admin companion only (`__ADMIN_APP__`).
  {
    path: '/admin',
    element: <RequireAdmin>{withSuspense(<AdminLayout />)}</RequireAdmin>,
    children: [
      { index: true, element: withSuspense(<AdminPage />) },
      { path: 'review', element: withSuspense(<AdminReviewPage />) },
      { path: 'tickets', element: withSuspense(<AdminTicketsPage />) },
      {
        path: 'tickets/:userId',
        element: withSuspense(<AdminUserTicketsPage />),
      },
      { path: 'menu', element: withSuspense(<AdminMenuPage />) },
      { path: 'stock', element: withSuspense(<AdminStockPage />) },
      { path: 'settings', element: withSuspense(<AdminSettingsPage />) },
    ],
  },
  // Standalone kitchen display window
  {
    path: '/kds',
    element: <RequireKdsAccess>{withSuspense(<KdsPage />)}</RequireKdsAccess>,
  },
  // First-run setup screen for the standalone KDS Electron app.
  {
    path: '/kds-setup',
    element: (
      <RequireKdsAccess>{withSuspense(<KdsSetupPage />)}</RequireKdsAccess>
    ),
  },
  {
    path: '/admin-setup',
    element: (
      <RequireAdminApp>{withSuspense(<AdminSetupPage />)}</RequireAdminApp>
    ),
  },
  // Reservation panel — separate window. Login lives at /reservations,
  // the actual app shell lives at /reservations/app and is gated by RequireHost.
  {
    path: '/reservations',
    element: (
      <RequireReservations>
        {withSuspenseNoFallback(<ReservationsLoginPage />)}
      </RequireReservations>
    ),
  },
  {
    path: '/reservations/app',
    element: (
      <RequireReservations>
        <RequireHost>{withSuspense(<ReservationsLayout />)}</RequireHost>
      </RequireReservations>
    ),
    children: [
      { index: true, element: withSuspense(<ReservationsFloorPage />) },
      { path: 'list', element: withSuspense(<ReservationsListPage />) },
    ],
  },
].map(withRouteError);
