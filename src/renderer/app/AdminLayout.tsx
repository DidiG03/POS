import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../stores/adminSession';
import { useLicenseCapabilities } from '../stores/licenseCapabilities';
import { BrandMark } from '../components/BrandMark';
import { DocumentMeta } from '../components/DocumentMeta';
import { StatusChip, cn } from '../components/ui';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { reportAppError } from '../utils/reportAppError';
import type { Tone } from '../components/ui';
import {
  ADMIN_RAIL_COLLAPSED_KEY,
  SidebarCollapseToggle,
  useStoredFlag,
} from '../components/SidebarCollapseToggle';
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
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [railCollapsed, setRailCollapsed] = useStoredFlag(
    ADMIN_RAIL_COLLAPSED_KEY,
  );
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
        labelKey: hasTables ? 'adminLayout.menu' : 'adminLayout.products',
        icon: <IconMenuBook />,
      },
      { to: '/admin/stock', labelKey: 'adminLayout.stock', icon: <IconBox /> },
      {
        to: '/admin/settings',
        labelKey: 'adminLayout.settings',
        icon: <IconSettings />,
      },
    ],
    [hasTables],
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
    try {
      window.dispatchEvent(
        new CustomEvent('pos:forceLogout', {
          detail: { reason: t('common.loggedOut') },
        }),
      );
    } catch {
      setMe(null as any);
      navigate('/admin');
    }
    await window.api.auth.logoutAdmin().catch(() => {});
    setShowNotifications(false);
    setUnreadCount(0);
  };

  return (
    <div className="admin-app pos-app flex h-screen min-h-0 text-gray-100">
      <DocumentMeta title={t('adminLayout.panelTitle')} />
      {/* Sidebar — the back office has six sections, which is more than a
          horizontal bar can hold without truncating. */}
      <aside
        className={cn(
          'admin-rail relative z-20 hidden shrink-0 flex-col border-r border-white/[0.06] transition-[width] duration-200 lg:flex',
          railCollapsed ? 'is-collapsed w-16' : 'w-[220px]',
        )}
      >
        <div
          className={cn(
            'flex min-h-[var(--pos-header-h)] shrink-0 items-center',
            railCollapsed ? 'justify-center px-1' : 'px-4',
          )}
        >
          <BrandMark
            size="sm"
            compact
            wordmark={!railCollapsed}
            subtitle={railCollapsed ? undefined : t('adminLayout.panelTitle')}
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 py-3">
          <div className="space-y-0.5">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={t(item.labelKey)}
                className={({ isActive }) =>
                  cn(
                    'pos-side-link',
                    isActive ? 'pos-side-link--active' : 'pos-side-link--idle',
                  )
                }
              >
                {item.icon}
                <span className={cn('truncate', railCollapsed && 'sr-only')}>
                  {t(item.labelKey)}
                </span>
              </NavLink>
            ))}
          </div>
        </nav>
        <div className="shrink-0 border-t border-white/[0.06] px-2.5 py-2.5">
          {railCollapsed ? (
            <div className="flex flex-col items-center gap-1.5">
              <span className="pos-avatar">
                {initials(me?.displayName || 'A')}
              </span>
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
          ) : (
            <div className="flex items-center gap-2.5 px-1.5 py-1">
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
          )}
        </div>
        <SidebarCollapseToggle
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed(!railCollapsed)}
        />
      </aside>

      <div className="admin-workspace flex min-w-0 flex-1 flex-col">
        <header className="pos-header safe-x flex shrink-0 items-center gap-3">
          <div className="lg:hidden">
            <BrandMark size="sm" compact wordmark={false} />
          </div>
          <h1 className="admin-page-title hidden min-w-0 flex-1 truncate lg:block">
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
                  className="pos-surface-panel absolute right-0 z-50 mt-1.5 w-[22.5rem] max-w-[calc(100vw-1.25rem)] overflow-hidden"
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
                          try {
                            await window.api.admin.markAllNotificationsRead({
                              userId: me.id,
                            });
                            setUnreadCount(0);
                          } catch (e) {
                            reportAppError(e, {
                              fallback: t('common.actionFailed'),
                              key: `notifications.markAll:${me.id}`,
                            });
                          }
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
                      onNavigate={() => setShowNotifications(false)}
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

        <main
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-auto',
            location.pathname.startsWith('/admin/settings')
              ? 'px-3 pt-2 pb-4 lg:p-0'
              : 'safe-pb px-6 pt-5 pb-8 sm:px-8 sm:pt-6',
          )}
        >
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
  onNavigate,
}: {
  userId: number;
  onCount: (n: number) => void;
  onNavigate?: () => void;
}) {
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

  return <NotificationsPanel items={items} admin onNavigate={onNavigate} />;
}
