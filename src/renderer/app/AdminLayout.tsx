import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../stores/adminSession';
import { BrandMark } from '../components/BrandMark';
import { EmptyState, StatusChip, cn } from '../components/ui';
import type { Tone } from '../components/ui';
import {
  IconBell,
  IconBox,
  IconChart,
  IconGrid,
  IconLogout,
  IconMenuBook,
  IconSettings,
  IconTicket,
} from '../components/icons';

type AdminNavItem = {
  to: string;
  end?: boolean;
  labelKey: string;
  icon: ReactNode;
};

export default function AdminLayout() {
  const { t } = useTranslation();
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const me = useAdminSessionStore((s) => s.user);
  const setMe = useAdminSessionStore((s) => s.setUser);
  const navigate = useNavigate();
  const location = useLocation();

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

  const connectivity = useMemo<{ label: string; tone: Tone }>(() => {
    if (!netOk || !backendOk)
      return { label: t('adminLayout.connPoor'), tone: 'danger' };
    const dt = latencyMs ?? 0;
    if (dt >= 900) return { label: t('adminLayout.connPoor'), tone: 'danger' };
    if (dt >= 300) return { label: t('adminLayout.connGood'), tone: 'warn' };
    return { label: t('adminLayout.connGreat'), tone: 'accent' };
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

  const navItems = useMemo<AdminNavItem[]>(
    () => [
      {
        to: '/admin',
        end: true,
        labelKey: 'adminLayout.overview',
        icon: <IconGrid />,
      },
      {
        to: '/admin/review',
        labelKey: 'adminLayout.review',
        icon: <IconChart />,
      },
      {
        to: '/admin/tickets',
        labelKey: 'adminLayout.tickets',
        icon: <IconTicket />,
      },
      {
        to: '/admin/menu',
        labelKey: 'adminLayout.menu',
        icon: <IconMenuBook />,
      },
      { to: '/admin/stock', labelKey: 'adminLayout.stock', icon: <IconBox /> },
      {
        to: '/admin/settings',
        labelKey: 'adminLayout.settings',
        icon: <IconSettings />,
      },
    ],
    [],
  );

  // Longest matching route wins so /admin doesn't claim every child path.
  const activeLabel = useMemo(() => {
    const path = location.pathname.replace(/\/+$/, '') || '/admin';
    const match = navItems
      .filter((item) => path === item.to || path.startsWith(`${item.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0];
    return match ? t(match.labelKey) : t('adminLayout.overview');
  }, [location.pathname, navItems, t]);

  const connectivityTitle = !netOk
    ? t('common.offline')
    : !backendOk
      ? t('adminLayout.connCannotReach')
      : checkedAt
        ? t('adminLayout.connLatencyWithLast', {
            ms: latencyMs ?? 0,
            when: new Date(checkedAt).toLocaleTimeString(),
          })
        : t('adminLayout.connLatencyTooltip', { ms: latencyMs ?? 0 });

  const signOut = async () => {
    // Clear persisted admin session so reopening /admin requires a PIN again.
    setMe(null as any);
    await window.api.auth.logoutAdmin().catch(() => {});
    setShowNotifications(false);
    setUnreadCount(0);
    navigate('/admin');
  };

  return (
    <div className="pos-app flex h-screen min-h-0 text-gray-100">
      {/* Sidebar — the back office has six sections, which is more than a
          horizontal bar can hold without truncating. */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-white/7 bg-[var(--pos-canvas)] lg:flex">
        <div className="flex h-[52px] shrink-0 items-center border-b border-white/7 px-4">
          <BrandMark size="sm" compact subtitle={t('adminLayout.panelTitle')} />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="space-y-0.5">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'pos-side-link',
                    isActive ? 'pos-side-link--active' : 'pos-side-link--idle',
                  )
                }
              >
                {item.icon}
                <span className="truncate">{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </div>
        </nav>
        <div className="shrink-0 border-t border-white/7 p-2.5">
          <div className="flex items-center gap-2 rounded-lg px-1.5 py-1.5">
            <span className="pos-avatar">
              {initials(me?.displayName || 'A')}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-gray-100">
                {me?.displayName || t('adminLayout.panelTitle')}
              </div>
              <div className="truncate text-[11px] text-gray-500">
                {String(me?.role || 'ADMIN')}
              </div>
            </div>
            <button
              type="button"
              className="pos-icon-btn shrink-0 hover:!bg-rose-500/12 hover:!text-rose-300"
              onClick={signOut}
              title={t('common.logout')}
              aria-label={t('common.logout')}
            >
              <IconLogout />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="pos-header safe-x flex shrink-0 items-center gap-3 pt-[max(0px,env(safe-area-inset-top))]"
          style={{ minHeight: 'var(--pos-header-h)' }}
        >
          <div className="lg:hidden">
            <BrandMark size="sm" compact wordmark={false} />
          </div>
          <h1 className="hidden min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-gray-50 lg:block">
            {activeLabel}
          </h1>

          {/* Compact nav for narrow admin windows. */}
          <nav className="no-scrollbar -mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 lg:hidden">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={t(item.labelKey)}
                className={({ isActive }) =>
                  cn(
                    'pos-nav-link shrink-0',
                    isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle',
                  )
                }
              >
                {item.icon}
                <span className="hidden sm:inline">{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-1.5">
            <StatusChip
              tone={connectivity.tone}
              title={connectivityTitle}
              className="hidden sm:inline-flex"
            >
              {connectivity.label}
            </StatusChip>

            <div
              className="relative inline-block"
              tabIndex={-1}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node))
                  setShowNotifications(false);
              }}
            >
              <button
                type="button"
                className="pos-icon-btn"
                aria-label={t('common.notifications')}
                onClick={() => setShowNotifications((v) => !v)}
              >
                <IconBell />
                {unreadCount > 0 && (
                  <span className="absolute right-1.5 top-1.5 flex min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-[14px] text-white tabular">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
              {showNotifications && (
                <div
                  className="pos-surface-panel absolute right-0 z-50 mt-1.5 w-80 overflow-hidden"
                  tabIndex={-1}
                >
                  <div className="flex items-center justify-between gap-3 border-b border-white/7 px-3 py-2.5">
                    <div className="text-[13px] font-semibold text-gray-100">
                      {t('common.notifications')}
                    </div>
                    {unreadCount > 0 && (
                      <button
                        className="rounded px-1 text-[12px] font-medium text-gray-400 hover:text-gray-100"
                        style={{ minHeight: 0 }}
                        type="button"
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
                  <div className="max-h-[70vh] overflow-auto p-2">
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
              className="pos-icon-btn hover:!bg-rose-500/12 hover:!text-rose-300 lg:hidden"
              onClick={signOut}
              title={t('common.logout')}
              aria-label={t('common.logout')}
            >
              <IconLogout />
            </button>
          </div>
        </header>

        <main className="safe-pb safe-x flex min-h-0 flex-1 flex-col overflow-auto py-4 sm:py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
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
    return (
      <EmptyState
        compact
        icon={<IconBell />}
        title={tr('common.noNotifications')}
      />
    );
  return (
    <ul className="space-y-1">
      {items.map((n) => (
        <li
          key={n.id}
          className={cn(
            'rounded-lg border px-2.5 py-2',
            n.readAt
              ? 'border-transparent bg-white/3'
              : 'border-white/12 bg-white/[0.05]',
          )}
        >
          <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500">
            <span className="truncate font-medium text-gray-400">
              {n.userName}
            </span>
            <span className="shrink-0 tabular">
              {formatAdminNotificationTimestamp(n.createdAt, tr)}
            </span>
          </div>
          <div className="mt-1 text-[13px] leading-snug text-gray-200">
            {n.message}
          </div>
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
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}
