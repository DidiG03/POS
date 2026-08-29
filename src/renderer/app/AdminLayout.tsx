import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../stores/adminSession';

/** Heroicons-style 24px outline icons (stroke 1.5) for consistent admin nav chrome. */
function NavIcon({ paths }: { paths: React.ReactNode }) {
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
      {paths}
    </svg>
  );
}

function IconOverview() {
  return (
    <NavIcon
      paths={
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
        />
      }
    />
  );
}

function IconReview() {
  return (
    <NavIcon
      paths={
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
        />
      }
    />
  );
}

function IconTickets() {
  return (
    <NavIcon
      paths={
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-3.75h-.008v-.008H7.5v.008zm0 3.75h-.008v-.008H7.5v.008zm0 3.75h-.008v-.008H7.5v.008zM13.5 6v.75m0 3v.75m0 3v.75m0 3V18M6 4.5h12A2.25 2.25 0 0 1 20.25 6.75v10.5A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75A2.25 2.25 0 0 1 6 4.5Z"
        />
      }
    />
  );
}

function IconMenu() {
  return (
    <NavIcon
      paths={
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm0 5.25h.007v.008H3.75v-.008Zm0 5.25h.007v.008H3.75v-.008Z"
        />
      }
    />
  );
}

function IconStock() {
  return (
    <NavIcon
      paths={
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"
        />
      }
    />
  );
}

function IconSettings() {
  return (
    <NavIcon
      paths={
        <>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.003.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a7.722 7.722 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
          />
        </>
      }
    />
  );
}

function IconLogout() {
  return (
    <NavIcon
      paths={
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
        />
      }
    />
  );
}

export default function AdminLayout() {
  const { t } = useTranslation();
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const me = useAdminSessionStore((s) => s.user);
  const setMe = useAdminSessionStore((s) => s.setUser);
  const navigate = useNavigate();

  const [netOk, setNetOk] = useState(true);
  const [backendOk, setBackendOk] = useState(true);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [checkedAt, setCheckedAt] = useState<number>(0);

  useEffect(() => {
    const update = () => {
      try {
        setNetOk(
          typeof navigator === 'undefined' ? true : navigator.onLine !== false,
        );
      } catch {
        setNetOk(true);
      }
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tick = async () => {
      if (isHidden()) return;
      const t0 = Date.now();
      try {
        await window.api.settings.get();
        const dt = Date.now() - t0;
        if (!cancelled) {
          setBackendOk(true);
          setLatencyMs(dt);
          setCheckedAt(Date.now());
        }
      } catch {
        if (!cancelled) {
          setBackendOk(false);
          setLatencyMs(null);
          setCheckedAt(Date.now());
        }
      }
    };
    tick();
    const pollIntervalId = window.setInterval(tick, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(pollIntervalId);
    };
  }, []);

  const connectivity = useMemo(() => {
    if (!netOk || !backendOk)
      return {
        label: t('adminLayout.connPoor'),
        cls: 'bg-rose-900/30 border-rose-800 text-rose-100',
      };
    const dt = latencyMs ?? 0;
    if (dt >= 900)
      return {
        label: t('adminLayout.connPoor'),
        cls: 'bg-rose-900/30 border-rose-800 text-rose-100',
      };
    if (dt >= 300)
      return {
        label: t('adminLayout.connGood'),
        cls: 'bg-amber-900/30 border-amber-800 text-amber-100',
      };
    return {
      label: t('adminLayout.connGreat'),
      cls: 'bg-emerald-900/30 border-emerald-800 text-emerald-100',
    };
  }, [netOk, backendOk, latencyMs, t]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!me || me.role !== 'ADMIN') {
        if (!cancelled) setUnreadCount(0);
        return;
      }
      const unread = await window.api.admin
        .listNotifications({ userId: me.id, onlyUnread: true })
        .catch(() => []);
      if (!cancelled) setUnreadCount(unread.length || 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [me?.id, me?.role]);
  return (
    <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
      <header className="bg-gray-800 pb-2.5 sm:pb-3 pt-[max(0.625rem,env(safe-area-inset-top))] sm:pt-[max(0.75rem,env(safe-area-inset-top))] safe-x grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2 sm:gap-3 items-center">
        <div className="font-semibold justify-self-start">
          {t('adminLayout.panelTitle')}
        </div>

        {/* Center nav */}
        <div className="flex items-center justify-start sm:justify-center min-w-0">
          <nav className="flex items-center gap-2 overflow-x-auto whitespace-nowrap">
            <NavLink
              to="/admin"
              end
              className={({ isActive }) =>
                `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
              }
              title={t('adminLayout.overview')}
            >
              <IconOverview />
              <span className="hidden sm:inline">
                {t('adminLayout.overview')}
              </span>
            </NavLink>
            <NavLink
              to="/admin/review"
              className={({ isActive }) =>
                `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
              }
              title={t('adminLayout.review')}
            >
              <IconReview />
              <span className="hidden sm:inline">
                {t('adminLayout.review')}
              </span>
            </NavLink>
            <NavLink
              to="/admin/tickets"
              className={({ isActive }) =>
                `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
              }
              title={t('adminLayout.tickets')}
            >
              <IconTickets />
              <span className="hidden sm:inline">
                {t('adminLayout.tickets')}
              </span>
            </NavLink>
            <NavLink
              to="/admin/menu"
              className={({ isActive }) =>
                `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
              }
              title={t('adminLayout.menu')}
            >
              <IconMenu />
              <span className="hidden sm:inline">{t('adminLayout.menu')}</span>
            </NavLink>
            <NavLink
              to="/admin/stock"
              className={({ isActive }) =>
                `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
              }
              title={t('stockPanel.title')}
            >
              <IconStock />
              <span className="hidden sm:inline">{t('adminLayout.stock')}</span>
            </NavLink>
            <NavLink
              to="/admin/settings"
              className={({ isActive }) =>
                `pos-nav-link ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'}`
              }
              title={t('adminLayout.settings')}
            >
              <IconSettings />
              <span className="hidden sm:inline">
                {t('adminLayout.settings')}
              </span>
            </NavLink>
          </nav>
        </div>

        {/* Right utilities */}
        <div className="flex items-center gap-2 sm:gap-3 justify-start sm:justify-end min-w-0">
          <div
            className={`pos-status-chip ${connectivity.cls}`}
            title={
              !netOk
                ? t('common.offline')
                : !backendOk
                  ? t('adminLayout.connCannotReach')
                  : checkedAt
                    ? t('adminLayout.connLatencyWithLast', {
                        ms: latencyMs ?? 0,
                        when: new Date(checkedAt).toLocaleTimeString(),
                      })
                    : t('adminLayout.connLatencyTooltip', {
                        ms: latencyMs ?? 0,
                      })
            }
          >
            {connectivity.label}
          </div>

          <div className="relative inline-block">
            <button
              type="button"
              className="pos-icon-btn cursor-pointer"
              aria-label={t('common.notifications')}
              onClick={() => setShowNotifications((v) => !v)}
            >
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
                  d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.454 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
                />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] px-1 rounded-full">
                  {unreadCount}
                </span>
              )}
            </button>
            {showNotifications && (
              <div className="absolute right-0 mt-2 w-80 bg-gray-800 rounded border border-gray-700 shadow-lg z-50">
                <div className="p-3 text-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold">
                      {t('common.notifications')}
                    </div>
                    {unreadCount > 0 && (
                      <button
                        className="text-xs text-blue-400 hover:underline"
                        onClick={async () => {
                          if (!me?.id) return;
                          await window.api.admin
                            .markAllNotificationsRead({ userId: me.id })
                            .catch(() => {});
                          setUnreadCount(0);
                        }}
                      >
                        {t('common.markAllRead')}
                      </button>
                    )}
                  </div>
                  <AdminNotificationsList
                    userId={me?.id ?? 0}
                    onCount={(n) => setUnreadCount(n)}
                  />
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            className="pos-danger-btn cursor-pointer"
            onClick={async () => {
              // Clear persisted admin session so reopening /admin requires PIN again.
              setMe(null as any);
              // Force this window back to login.
              await window.api.auth.logoutAdmin().catch(() => {});
              setShowNotifications(false);
              setUnreadCount(0);
              navigate('/admin');
            }}
            title={t('common.logout')}
          >
            <IconLogout />
          </button>
          {/* <button
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
            onClick={() => window.api.auth.syncStaffFromApi()}
          >
            Sync Staff
          </button>
          <button
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
            onClick={() => window.api.settings.testPrint()}
          >
            Test Printer
          </button>
          <button
            className="ml-2 px-3 py-1 rounded bg-red-600 hover:bg-red-700"
            onClick={() => window.close()}
          >
            Close
          </button> */}
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-auto py-3 sm:py-4 safe-pb safe-x">
        <Outlet />
      </main>
    </div>
  );
}

function AdminNotificationsList({
  userId,
  onCount,
}: {
  userId: number;
  onCount: (n: number) => void;
}) {
  const { t: tr } = useTranslation();
  const [items, setItems] = useState<
    {
      id: number;
      userId: number;
      userName: string;
      type: string;
      message: string;
      readAt: string | null;
      createdAt: string;
    }[]
  >([]);
  // PERF: keep a stable ref for the parent callback so this effect doesn't
  // re-run (and re-fetch) on every parent render. We only refetch on mount.
  const onCountRef = useRef(onCount);
  useEffect(() => {
    onCountRef.current = onCount;
  }, [onCount]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId) {
        if (!cancelled) setItems([]);
        return;
      }
      const all = await window.api.admin
        .listNotifications({ userId })
        .catch(() => []);
      if (cancelled) return;
      setItems(all);
      // PERF: derive unread count from the same response instead of issuing a
      // second IPC round-trip.
      const unread = (all || []).filter((n: any) => !n?.readAt).length;
      onCountRef.current(unread);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!items.length)
    return <div className="opacity-70">{tr('common.noNotifications')}</div>;
  return (
    <ul className="max-h-80 overflow-auto space-y-2">
      {items.map((n) => (
        <li key={n.id} className="p-2 rounded bg-gray-700/60">
          <div className="text-xs opacity-70 flex items-center justify-between">
            <span>{n.userName}</span>
            <span>{formatAdminNotificationTimestamp(n.createdAt, tr)}</span>
          </div>
          <div className="mt-1">{n.message}</div>
        </li>
      ))}
    </ul>
  );
}

function formatAdminNotificationTimestamp(
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
