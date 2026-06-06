import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../stores/session';
import { useTableStatus } from '@renderer/stores/tableStatus';
import { UpdateNotification } from '../components/UpdateNotification';
import { PrinterNotification } from '../components/PrinterNotification';
import { isClockOnlyRole, canSeeReportsOnMobile } from '@shared/utils/roles';
import { toast } from '../stores/toasts';
import { getOfflineQueueCount } from '../utils/offlineQueue';

function IconTables() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className="pos-icon"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
      />
    </svg>
  );
}

function IconReports() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M6 3h12v18H6V3Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M9 7h6M9 11h6M9 15h4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconClock() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 7v5l3 2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M10 7V5a2 2 0 0 1 2-2h7v18h-7a2 2 0 0 1-2-2v-2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M13 12H3m0 0 3-3M3 12l3 3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function AppLayout() {
  const { t } = useTranslation();
  const { user, setUser } = useSessionStore();
  const [showNotifications, setShowNotifications] = useState<boolean>(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const navigate = useNavigate();
  const [hasOpen, setHasOpen] = useState<boolean>(false);
  const [confirmModal, setConfirmModal] = useState<boolean>(false);
  const isBrowserClient =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const [netOk, setNetOk] = useState(true);
  const [backendOk, setBackendOk] = useState(true);
  const [queued, setQueued] = useState<number>(0);
  const [syncOk, setSyncOk] = useState<boolean>(true);
  const [billing, setBilling] = useState<{
    billingEnabled?: boolean;
    status?: string;
  } | null>(null);
  const [billingCheckedAt, setBillingCheckedAt] = useState<number>(0);

  const forceLogout = useCallback(
    (reason = t('common.loggedOut')) => {
      // Centralized logout so browser clients also clear tokens + SSE (via renderer/main.tsx handler).
      try {
        window.dispatchEvent(
          new CustomEvent('pos:forceLogout', { detail: { reason } }),
        );
        return;
      } catch {
        // fallback
      }
      try {
        setUser(null);
      } catch {
        // ignore
      }
      try {
        navigate('/');
      } catch {
        // ignore
      }
    },
    [navigate, setUser, t],
  );

  const handleNotifCount = useCallback((n: number) => {
    setUnreadCount(n);
  }, []);

  useEffect(() => {
    // Expose a simple global flag other pages can read to disable risky actions during network issues
    (window as any).__BACKEND_OK__ = backendOk;
  }, [backendOk]);

  useEffect(() => {
    if (!isBrowserClient) return;
    const update = () => setNetOk(Boolean(navigator.onLine));
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [isBrowserClient]);

  // Offline/sync indicator: browser tablets show the local IndexedDB queue;
  // Electron host shows the cloud outbox (when configured).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tick = async () => {
      if (isHidden()) return;
      try {
        if (isBrowserClient) {
          const count = await getOfflineQueueCount();
          if (!cancelled) {
            setQueued(Number.isFinite(count) ? count : 0);
            setSyncOk(true);
          }
          return;
        }
        const st = await (window.api as any).offline?.getStatus?.();
        const q = Number((st as any)?.queued || 0);
        if (!cancelled) {
          setQueued(Number.isFinite(q) ? q : 0);
          setSyncOk(true);
        }
      } catch {
        if (!cancelled) setSyncOk(false);
      }
    };
    tick();
    const onQueueChange = (e: Event) => {
      if (!isBrowserClient || cancelled) return;
      const pending = Number((e as CustomEvent)?.detail?.pending ?? 0);
      setQueued(Number.isFinite(pending) ? pending : 0);
      setSyncOk(true);
    };
    if (isBrowserClient) {
      window.addEventListener('offline-queue:changed', onQueueChange);
    }
    const t = window.setInterval(tick, 10000);
    return () => {
      cancelled = true;
      if (isBrowserClient) {
        window.removeEventListener('offline-queue:changed', onQueueChange);
      }
      window.clearInterval(t);
    };
  }, [user?.id, isBrowserClient]);

  useEffect(() => {
    if (!isBrowserClient) return;
    const onDropped = (e: Event) => {
      const detail = (e as CustomEvent)?.detail || {};
      const msg = String(detail.lastError || t('common.offlineActionDropped'));
      toast.error(msg, { title: t('common.offlineActionFailed') });
    };
    window.addEventListener('offline-queue:dropped', onDropped);
    return () => {
      window.removeEventListener('offline-queue:dropped', onDropped);
    };
  }, [isBrowserClient, t]);

  useEffect(() => {
    if (!isBrowserClient) return;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tick = async () => {
      if (isHidden()) return;
      try {
        // Lightweight backend heartbeat. main.tsx includes timeouts/retries.
        await window.api.settings.get();
        if (!cancelled) setBackendOk(true);
      } catch {
        if (!cancelled) setBackendOk(false);
      }
    };
    tick();
    const t = window.setInterval(tick, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [isBrowserClient]);

  // Billing gate (cloud mode): if unpaid, pause POS until payment is completed.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tick = async () => {
      if (isHidden()) return;
      try {
        const s = await (window.api as any).billing?.getStatus?.();
        if (!cancelled) {
          setBilling(s || null);
          setBillingCheckedAt(Date.now());
        }
      } catch {
        // If billing status can't be checked (offline), don't lock the POS.
        if (!cancelled) {
          setBilling({ billingEnabled: false, status: 'ACTIVE' });
          setBillingCheckedAt(Date.now());
        }
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tick = async () => {
      if (isHidden()) return;
      const notifs = await window.api.notifications
        .list(user.id, true)
        .catch(() => []);
      if (!cancelled) setUnreadCount(notifs.length || 0);
    };
    void tick();
    const t = window.setInterval(tick, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      const open = await window.api.shifts.getOpen(user.id).catch(() => null);
      if (!cancelled) setHasOpen(Boolean(open));
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const clockOnly = Boolean(user && isClockOnlyRole((user as any).role));
  const isWaiter = String((user as any)?.role || '').toUpperCase() === 'WAITER';
  // Hide back-office tabs on mobile/tablet for roles that can't use them.
  const showReportsTab =
    !clockOnly &&
    (!isBrowserClient || canSeeReportsOnMobile((user as any)?.role));
  const billingEnabled = Boolean(billing?.billingEnabled);
  const billingStatus = String(billing?.status || 'ACTIVE').toUpperCase();
  const billingPaused =
    billingEnabled &&
    (billingStatus === 'PAST_DUE' || billingStatus === 'PAUSED');

  return (
    <div className="h-full flex flex-col min-h-0">
      {user && billingPaused && !clockOnly && (
        <div className="fixed inset-0 bg-black/70 z-[9999] flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded bg-gray-900 border border-gray-700 p-5">
            <div className="font-semibold text-lg">
              {t('layout.billingPausedTitle')}
            </div>
            <div className="mt-2 text-sm opacity-80">
              {t('layout.billingPausedBody')}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 text-sm"
                onClick={async () => {
                  // Electron: open admin window (will prompt for admin PIN/login)
                  await (window.api as any).admin
                    ?.openWindow?.()
                    .catch(() => false);
                }}
                type="button"
              >
                {t('layout.openAdminBilling')}
              </button>
              <button
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                onClick={() => window.location.reload()}
                type="button"
              >
                {t('common.retry')}
              </button>
            </div>
            {billingCheckedAt > 0 && (
              <div className="mt-3 text-xs opacity-60">
                {t('common.lastChecked', {
                  time: new Date(billingCheckedAt).toLocaleTimeString(),
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {isBrowserClient && (!netOk || !backendOk) && (
        <div className="bg-amber-600 text-black text-xs px-4 py-2">
          {t('layout.networkBanner')}
        </div>
      )}
      <header
        // The header is the topmost on-screen element, so it owns the
        // safe-area-top inset (notch / status-bar). We use `max(...)` so
        // the header keeps its normal vertical breathing room on devices
        // without a notch, but grows to clear the status bar on iPhones.
        // Horizontal inset: `.safe-x` (see index.css) uses max(px, env(...))
        // so desktop keeps padding; raw env() alone was overriding px-* with 0.
        className="bg-gray-800 pb-2.5 sm:pb-3 pt-[max(0.625rem,env(safe-area-inset-top))] sm:pt-[max(0.75rem,env(safe-area-inset-top))] safe-x flex sm:grid sm:grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3"
      >
        <div className="flex items-center gap-2 min-w-0 justify-start flex-1 sm:flex-initial">
          <div className="font-semibold min-w-0 truncate text-sm sm:text-base">
            <span className="hidden sm:inline">{user?.displayName}</span>
            <span className="sm:hidden">{user?.displayName}</span>
          </div>
          {user && (
            <>
              {hasOpen && (
                <button
                  className="cursor-pointer hover:underline text-xs sm:text-sm whitespace-nowrap text-gray-300 px-1.5 py-1 rounded hover:bg-gray-700/50"
                  onClick={async () => {
                    if (!clockOnly) {
                      const { openMap } = useTableStatus.getState();
                      const anyOpen = Object.values(openMap).some(Boolean);
                      if (anyOpen) {
                        toast.warn(t('layout.clockOutBlockedBody'), {
                          title: t('layout.clockOutBlockedTitle'),
                        });
                        return;
                      }
                    }
                    setConfirmModal(true);
                  }}
                >
                  {t('layout.clockOut')}
                </button>
              )}
              {confirmModal && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-9999">
                  <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-center">
                        {t('layout.clockOutConfirmTitle')}
                      </h2>
                      <button
                        onClick={() => setConfirmModal(false)}
                        className="cursor-pointer"
                      >
                        x
                      </button>
                    </div>
                    <button
                      className="w-full bg-red-600 text-white py-1 px-2 cursor-pointer hover:bg-red-700"
                      onClick={async () => {
                        const r: any = await window.api.shifts.clockOut(
                          user.id,
                        );
                        // Server now refuses to close a shift while the
                        // waiter still owns open tables. Show the reason
                        // (alert is enough here — this header has no
                        // toast root) and keep them logged in so they
                        // can finish/transfer the table.
                        if (r && typeof r === 'object' && r.ok === false) {
                          window.alert(
                            String(r.error || t('layout.clockOutOpenTables')),
                          );
                          setConfirmModal(false);
                          return;
                        }
                        setHasOpen(false);
                        forceLogout(t('common.clockedOut'));
                      }}
                    >
                      {t('layout.clockOut')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Center nav — hidden on mobile to keep the header compact.
            Mobile users only ever have one or two destinations and we
            already gate role-restricted routes via RequireReportsAccess /
            RequireKdsAccess in routes.tsx. */}
        <div className="hidden sm:flex items-center justify-center min-w-0">
          <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap">
            {!isWaiter && (
              <NavLink
                to="/app/clock"
                className={({ isActive }) =>
                  `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
                }
                title={t('layout.clock')}
              >
                <IconClock />
                <span>{t('layout.clock')}</span>
              </NavLink>
            )}
            {!clockOnly && (
              <NavLink
                to="/app/tables"
                className={({ isActive }) =>
                  `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
                }
                title={t('layout.tables')}
              >
                <IconTables />
                <span>{t('layout.tables')}</span>
              </NavLink>
            )}
            {showReportsTab && (
              <NavLink
                to="/app/reports"
                className={({ isActive }) =>
                  `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
                }
                title={t('layout.reports')}
              >
                <IconReports />
                <span>{t('layout.reports')}</span>
              </NavLink>
            )}
          </div>
        </div>

        <nav className="flex items-center gap-2 sm:gap-3 min-w-0 justify-end">
          {user && (
            <div
              className={`pos-status-chip hidden sm:flex ${
                !syncOk
                  ? 'border-rose-800 bg-rose-900/30 text-rose-100'
                  : queued > 0
                    ? 'border-amber-800 bg-amber-900/30 text-amber-100'
                    : 'border-emerald-800 bg-emerald-900/30 text-emerald-100'
              }`}
              title={
                !syncOk
                  ? t('common.offlineCannotReach')
                  : queued > 0
                    ? t('common.syncingQueued')
                    : t('common.allSynced')
              }
            >
              {!syncOk
                ? t('layout.syncIndicatorOffline')
                : queued > 0
                  ? t('layout.syncIndicatorSyncing', { count: queued })
                  : t('layout.syncIndicatorOnline')}
            </div>
          )}
          {/* Mobile: just a colored dot. */}
          {user && (
            <span
              className={`sm:hidden inline-block w-2.5 h-2.5 rounded-full ${
                !syncOk
                  ? 'bg-rose-500'
                  : queued > 0
                    ? 'bg-amber-400'
                    : 'bg-emerald-500'
              }`}
              aria-label={
                !syncOk
                  ? t('common.offline')
                  : queued > 0
                    ? t('common.syncing', { count: queued })
                    : t('common.online')
              }
              title={
                !syncOk
                  ? t('common.offlineCannotReach')
                  : queued > 0
                    ? t('common.syncingQueued')
                    : t('common.allSynced')
              }
            />
          )}

          {/* Notification bell (kept OUTSIDE the horizontal scroller so the dropdown isn't clipped) */}
          <div
            className="relative inline-block"
            tabIndex={-1}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setShowNotifications(false);
            }}
          >
            <button
              className="pos-icon-btn cursor-pointer"
              aria-label={t('common.notifications')}
              onClick={() => setShowNotifications((v) => !v)}
              type="button"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="pos-icon"
              >
                <path d="M12 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 006 14h12a1 1 0 00.707-1.707L18 11.586V8a6 6 0 00-6-6zm0 20a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] px-1 rounded-full min-w-[1.1rem] text-center">
                  {unreadCount}
                </span>
              )}
            </button>
            {showNotifications && (
              <div
                className="absolute right-0 mt-2 w-72 bg-gray-800 rounded border border-gray-700 shadow-lg z-50"
                tabIndex={-1}
              >
                <div className="p-3 text-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold">
                      {t('common.notifications')}
                    </div>
                    {user && unreadCount > 0 && (
                      <button
                        className="text-xs text-blue-400 hover:underline"
                        onClick={async () => {
                          await window.api.notifications
                            .markAllRead(user.id)
                            .catch(() => {});
                          setUnreadCount(0);
                        }}
                        type="button"
                      >
                        {t('common.markAllRead')}
                      </button>
                    )}
                  </div>
                  {user ? (
                    <NotificationsList
                      userId={user.id}
                      onCount={handleNotifCount}
                    />
                  ) : (
                    <div className="opacity-70">
                      {t('common.noNotifications')}
                    </div>
                  )}
                  {user && <OwnerRequests userId={user.id} />}
                </div>
              </div>
            )}
          </div>

          {user && (
            <button
              className="pos-danger-btn ml-0.5 cursor-pointer"
              onClick={() => {
                forceLogout(t('common.loggedOut'));
              }}
              type="button"
              title={t('common.logout')}
              aria-label={t('common.logout')}
            >
              <IconLogout />
            </button>
          )}
        </nav>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden py-2 sm:py-4 safe-pb safe-x">
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </main>
      <UpdateNotification />
      <PrinterNotification />
    </div>
  );
}

function NotificationsList({
  userId,
  onCount,
}: {
  userId: number;
  onCount: (n: number) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<
    {
      id: number;
      type: string;
      message: string;
      readAt: string | null;
      createdAt: string;
    }[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = await window.api.notifications.list(userId).catch(() => []);
      if (cancelled) return;
      setItems(all);
      const unreadCount = Array.isArray(all)
        ? all.filter((n: any) => !n?.readAt).length
        : 0;
      onCount(unreadCount);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, onCount]);
  const filtered = items.filter(
    (n) => !/requested to add items/i.test(n.message),
  );
  if (!filtered.length)
    return <div className="opacity-70">{t('common.noNotifications')}</div>;
  return (
    <ul className="max-h-72 overflow-auto space-y-2">
      {filtered.map((n) => (
        <li key={n.id} className="p-2 rounded bg-gray-700/60">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-70">
              {formatNotificationTimestamp(n.createdAt, t)}
            </span>
            {!n.readAt && (
              <span className="text-[10px] bg-blue-600 rounded px-1">
                {t('common.newBadge')}
              </span>
            )}
          </div>
          <div className="mt-1">{n.message}</div>
        </li>
      ))}
    </ul>
  );
}

function OwnerRequests({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<
    Array<{
      id: number;
      area: string;
      tableLabel: string;
      requesterId: number;
      items: any[];
      note?: string | null;
      createdAt: string;
    }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await window.api.requests.listForOwner(userId).catch(() => []);
      if (!cancelled) setRows(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);
  if (!rows.length) return null;
  return (
    <div className="mt-3 border-t border-gray-700 pt-2 max-h-64 overflow-auto">
      <div className="text-xs opacity-70 mb-1">{t('layout.orderRequests')}</div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="p-2 rounded bg-gray-700/60">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                {t('layout.requestNumber', {
                  area: r.area,
                  table: r.tableLabel,
                  id: r.id,
                })}
              </div>
              <span className="text-xs opacity-70">
                {formatNotificationTimestamp(r.createdAt, t)}
              </span>
            </div>
            {r.note && <div className="text-xs opacity-70 mt-1">{r.note}</div>}
            <div className="mt-2 text-xs">
              {Array.isArray(r.items) && r.items.length ? (
                <ul className="list-disc ml-4 space-y-0.5">
                  {r.items.map((it: any, idx: number) => (
                    <li key={idx}>
                      {String(it.name || t('common.item'))} ×
                      {Number(it.qty || 1)}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="opacity-70">{t('common.noItems')}</div>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                className="px-2 py-1 bg-emerald-700 rounded"
                onClick={async () => {
                  await window.api.requests
                    .approve(r.id, userId)
                    .catch(() => {});
                  setRows((prev) => prev.filter((x) => x.id !== r.id));
                }}
              >
                {t('common.approve')}
              </button>
              <button
                className="px-2 py-1 bg-rose-700 rounded"
                onClick={async () => {
                  await window.api.requests
                    .reject(r.id, userId)
                    .catch(() => {});
                  setRows((prev) => prev.filter((x) => x.id !== r.id));
                }}
              >
                {t('common.reject')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatNotificationTimestamp(
  iso: string,
  tr: (key: string, opt?: Record<string, unknown>) => string,
): string {
  const createdAt = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - createdAt);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return tr('time.minutesAgo', { count: minutes });
  }
  if (diffMs < dayMs) {
    const hours = Math.max(1, Math.floor(diffMs / hourMs));
    return tr('time.hoursAgo', { count: hours });
  }
  if (diffMs < weekMs) {
    const days = Math.max(1, Math.floor(diffMs / dayMs));
    return tr('time.daysAgo', { count: days });
  }

  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yy} ${hh}-${min}-${ss}`;
}
