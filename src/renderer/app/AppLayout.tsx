import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../stores/session';
import { useTableStatus } from '@renderer/stores/tableStatus';
import { UpdateNotification } from '../components/UpdateNotification';
import { PrinterNotification } from '../components/PrinterNotification';
import { FailedSyncPanel } from '../components/FailedSyncPanel';
import { BrandMark } from '../components/BrandMark';
import { isClockOnlyRole, canSeeReportsOnMobile } from '@shared/utils/roles';
import { toast } from '../stores/toasts';
import { getOfflineQueueCount } from '../utils/offlineQueue';
import { isHostUnreachable } from '../utils/netQuality';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Modal,
  StatusChip,
  cn,
} from '../components/ui';
import {
  IconBell,
  IconClock,
  IconLogout,
  IconReports,
  IconTables,
  IconWifiOff,
} from '../components/icons';

export default function AppLayout() {
  const { t } = useTranslation();
  const { user, setUser } = useSessionStore();
  const [showNotifications, setShowNotifications] = useState<boolean>(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const navigate = useNavigate();
  const location = useLocation();
  const flushTablesFloor = location.pathname.includes('/app/tables');
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
  // Electron host shows pending local print retries.
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
        const ping = (window.api as any).health?.ping;
        if (typeof ping === 'function') await ping();
        else await window.api.settings.get();
        if (!cancelled) setBackendOk(true);
      } catch {
        if (!cancelled) setBackendOk(!isHostUnreachable());
      }
    };
    tick();
    const t = window.setInterval(tick, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [isBrowserClient]);

  // Billing overlay: if the subscription lapses while already signed in.
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

  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'pos-nav-link',
      isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle',
    );

  const syncTone = !syncOk ? 'danger' : queued > 0 ? 'warn' : 'accent';
  const syncTitle = !syncOk
    ? t('common.offlineCannotReach')
    : queued > 0
      ? t('common.syncingQueued')
      : t('common.allSynced');

  return (
    <div className="pos-app flex h-full min-h-0 flex-col">
      <Modal
        open={Boolean(user && billingPaused && !clockOnly)}
        onClose={() => {}}
        dismissable={false}
        size="md"
        title={t('layout.billingPausedTitle')}
        footer={
          <>
            <Button onClick={() => window.location.reload()}>
              {t('common.retry')}
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                // Electron: open admin window (will prompt for admin PIN/login)
                await (window.api as any).admin
                  ?.openWindow?.()
                  .catch(() => false);
              }}
            >
              {t('layout.openAdminBilling')}
            </Button>
          </>
        }
      >
        <div className="text-[13px] leading-relaxed text-gray-300">
          {t('layout.billingPausedBody')}
        </div>
        {billingCheckedAt > 0 && (
          <div className="mt-3 text-[12px] text-gray-500">
            {t('common.lastChecked', {
              time: new Date(billingCheckedAt).toLocaleTimeString(),
            })}
          </div>
        )}
      </Modal>

      {isBrowserClient && (!netOk || !backendOk) && (
        <div className="flex items-center justify-center gap-2 border-b border-amber-500/25 bg-amber-500/12 px-4 py-1.5 text-[12px] font-medium text-amber-200">
          <IconWifiOff className="size-[15px] shrink-0" />
          {t('layout.networkBanner')}
        </div>
      )}

      <header
        // The header is the topmost on-screen element, so it owns the
        // safe-area-top inset (notch / status-bar). `max(...)` keeps normal
        // breathing room on devices without a notch but clears the status bar
        // on iPhones. Horizontal inset comes from `.safe-x`.
        className="pos-header safe-x flex shrink-0 items-center gap-3 pt-[max(0px,env(safe-area-inset-top))]"
        style={{ minHeight: 'var(--pos-header-h)' }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BrandMark size="sm" compact subtitle="" className="hidden sm:flex" />
          <BrandMark
            size="sm"
            compact
            wordmark={false}
            className="shrink-0 sm:hidden"
          />

          {user ? (
            <>
              <span
                className="hidden h-5 w-px shrink-0 bg-white/8 sm:block"
                aria-hidden
              />
              {hasOpen ? (
                <button
                  type="button"
                  className="min-w-0 truncate rounded-md px-1.5 py-1 text-[13px] font-medium text-gray-300 transition-colors hover:bg-white/6 hover:text-gray-50"
                  style={{ minHeight: 0 }}
                  title={t('layout.clockOut')}
                  aria-label={t('layout.clockOut')}
                  onClick={() => {
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
                  {user.displayName}
                </button>
              ) : (
                <div className="min-w-0 truncate px-1.5 text-[13px] font-medium text-gray-400">
                  {user.displayName}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Center nav — hidden on mobile to keep the header compact. Mobile
            users only ever have one or two destinations and role-restricted
            routes are gated in routes.tsx. */}
        <nav className="hidden shrink-0 items-center sm:flex">
          <div className="pos-segmented">
            {!isWaiter && (
              <NavLink
                to="/app/clock"
                className={navClass}
                title={t('layout.clock')}
              >
                <IconClock />
                <span>{t('layout.clock')}</span>
              </NavLink>
            )}
            {!clockOnly && (
              <NavLink
                to="/app/tables"
                className={navClass}
                title={t('layout.tables')}
              >
                <IconTables />
                <span>{t('layout.tables')}</span>
              </NavLink>
            )}
            {showReportsTab && (
              <NavLink
                to="/app/reports"
                className={navClass}
                title={t('layout.reports')}
              >
                <IconReports />
                <span>{t('layout.reports')}</span>
              </NavLink>
            )}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {user && (
            <StatusChip
              tone={syncTone}
              title={syncTitle}
              className="hidden sm:inline-flex"
            >
              {!syncOk
                ? t('layout.syncIndicatorOffline')
                : queued > 0
                  ? t('layout.syncIndicatorSyncing', { count: queued })
                  : t('layout.syncIndicatorOnline')}
            </StatusChip>
          )}
          {/* Mobile: the dot alone carries the same state. */}
          {user && (
            <span
              className={cn(
                'mr-1 inline-block size-2 rounded-full sm:hidden',
                !syncOk
                  ? 'bg-rose-400'
                  : queued > 0
                    ? 'bg-amber-400'
                    : 'bg-emerald-400',
              )}
              aria-label={
                !syncOk
                  ? t('common.offline')
                  : queued > 0
                    ? t('common.syncing', { count: queued })
                    : t('common.online')
              }
              title={syncTitle}
            />
          )}

          {/* Kept OUTSIDE any horizontal scroller so the dropdown isn't clipped. */}
          <div
            className="relative inline-block"
            tabIndex={-1}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setShowNotifications(false);
            }}
          >
            <button
              className="pos-icon-btn"
              aria-label={t('common.notifications')}
              onClick={() => setShowNotifications((v) => !v)}
              type="button"
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
                  {user && unreadCount > 0 && (
                    <button
                      className="rounded px-1 text-[12px] font-medium text-gray-400 hover:text-gray-100"
                      style={{ minHeight: 0 }}
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
                <div className="max-h-[70vh] overflow-auto p-2">
                  {user ? (
                    <NotificationsList
                      userId={user.id}
                      onCount={handleNotifCount}
                    />
                  ) : (
                    <EmptyState
                      compact
                      title={t('common.noNotifications')}
                      icon={<IconBell />}
                    />
                  )}
                  {user && <OwnerRequests userId={user.id} />}
                </div>
              </div>
            )}
          </div>

          {user && (
            <button
              className="pos-icon-btn hover:!bg-rose-500/12 hover:!text-rose-300"
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
        </div>
      </header>

      <main
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden',
          !flushTablesFloor && 'safe-pb safe-x py-3 sm:py-5',
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </main>

      {user && (
        <ConfirmDialog
          open={confirmModal}
          title={t('layout.clockOutConfirmTitle')}
          confirmLabel={t('layout.clockOut')}
          cancelLabel={t('common.cancel')}
          destructive
          onCancel={() => setConfirmModal(false)}
          onConfirm={async () => {
            const r: any = await window.api.shifts.clockOut(user.id);
            // The server refuses to close a shift while the waiter still owns
            // open tables. Surface the reason and keep them signed in so they
            // can finish or transfer the table.
            if (r && typeof r === 'object' && r.ok === false) {
              toast.error(String(r.error || t('layout.clockOutOpenTables')), {
                title: t('layout.clockOutBlockedTitle'),
              });
              setConfirmModal(false);
              return;
            }
            setHasOpen(false);
            forceLogout(t('common.clockedOut'));
          }}
        />
      )}

      <UpdateNotification />
      <PrinterNotification />
      <FailedSyncPanel />
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
    return (
      <EmptyState
        compact
        icon={<IconBell />}
        title={t('common.noNotifications')}
      />
    );
  return (
    <ul className="space-y-1">
      {filtered.map((n) => (
        <li
          key={n.id}
          className={cn(
            'rounded-lg border px-2.5 py-2',
            n.readAt
              ? 'border-transparent bg-white/3'
              : 'border-white/12 bg-white/[0.05]',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-gray-500 tabular">
              {formatNotificationTimestamp(n.createdAt, t)}
            </span>
            {!n.readAt && <Badge tone="accent">{t('common.newBadge')}</Badge>}
          </div>
          <div className="mt-1 text-[13px] leading-snug text-gray-200">
            {n.message}
          </div>
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
    <div className="mt-2 border-t border-white/7 pt-2">
      <div className="pos-section-label mb-1.5 px-1">
        {t('layout.orderRequests')}
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.id}
            className="rounded-lg border border-white/7 bg-white/3 px-2.5 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-[13px] font-medium text-gray-100">
                {t('layout.requestNumber', {
                  area: r.area,
                  table: r.tableLabel,
                  id: r.id,
                })}
              </div>
              <span className="shrink-0 text-[11px] text-gray-500 tabular">
                {formatNotificationTimestamp(r.createdAt, t)}
              </span>
            </div>
            {r.note && (
              <div className="mt-0.5 text-[12px] text-gray-400">{r.note}</div>
            )}
            <div className="mt-1.5 text-[12px] text-gray-300">
              {Array.isArray(r.items) && r.items.length ? (
                <ul className="space-y-0.5">
                  {r.items.map((it: any, idx: number) => (
                    <li key={idx} className="flex justify-between gap-2">
                      <span className="truncate">
                        {String(it.name || t('common.item'))}
                      </span>
                      <span className="shrink-0 text-gray-500 tabular">
                        ×{Number(it.qty || 1)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-gray-500">{t('common.noItems')}</div>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  await window.api.requests
                    .approve(r.id, userId)
                    .catch(() => {});
                  setRows((prev) => prev.filter((x) => x.id !== r.id));
                }}
              >
                {t('common.approve')}
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await window.api.requests
                    .reject(r.id, userId)
                    .catch(() => {});
                  setRows((prev) => prev.filter((x) => x.id !== r.id));
                }}
              >
                {t('common.reject')}
              </Button>
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
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}
