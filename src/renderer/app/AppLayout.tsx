import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/session';
import { useTableStatus } from '@renderer/stores/tableStatus';
import { UpdateNotification } from '../components/UpdateNotification';
import { PrinterNotification } from '../components/PrinterNotification';
import { isClockOnlyRole } from '../utils/roles';

export default function AppLayout() {
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

  // Offline/sync indicator: show how many queued cloud writes exist on the host.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tick = async () => {
      if (isHidden()) return;
      try {
        const st = await (window.api as any).offline?.getStatus?.();
        const q = Number((st as any)?.queued || 0);
        // Only show sync indicator if there are items ready to sync (not waiting for retry)
        if (!cancelled) {
          setQueued(Number.isFinite(q) ? q : 0);
          setSyncOk(true);
        }
      } catch {
        if (!cancelled) setSyncOk(false);
      }
    };
    tick();
    const t = window.setInterval(tick, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [user?.id]);

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
    (async () => {
      if (!user) return;
      const open = await window.api.shifts.getOpen(user.id).catch(() => null);
      setHasOpen(Boolean(open));
    })();
  }, [user]);

  const clockOnly = Boolean(user && isClockOnlyRole((user as any).role));
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
              POS paused — payment required
            </div>
            <div className="mt-2 text-sm opacity-80">
              Your subscription payment is overdue or inactive. The POS is
              locked until an admin completes payment.
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
                Open Admin Billing
              </button>
              <button
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                onClick={() => window.location.reload()}
                type="button"
              >
                Retry
              </button>
            </div>
            {billingCheckedAt > 0 && (
              <div className="mt-3 text-xs opacity-60">
                Last checked: {new Date(billingCheckedAt).toLocaleTimeString()}
              </div>
            )}
          </div>
        </div>
      )}
      {isBrowserClient && (!netOk || !backendOk) && (
        <div className="bg-amber-600 text-black text-xs px-4 py-2">
          Network is slow/offline. Please wait — actions like Send/Pay may be
          disabled to prevent mistakes.
        </div>
      )}
      <header className="bg-gray-800 px-3 sm:px-4 py-2 sm:py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="font-semibold min-w-0 truncate text-sm sm:text-base">
            <span className="hidden sm:inline">
              Code Orbit - {user?.displayName} -
            </span>
            <span className="sm:hidden">CO - {user?.displayName}</span>
          </div>
          {user && (
            <>
              {hasOpen && (
                <button
                  className="cursor-pointer hover:underline text-sm whitespace-nowrap"
                  onClick={async () => {
                    if (!clockOnly) {
                      const { openMap } = useTableStatus.getState();
                      const anyOpen = Object.values(openMap).some(Boolean);
                      if (anyOpen) {
                        alert(
                          "You can't clock out while you still have open tables. Please close all open orders first.",
                        );
                        return;
                      }
                    }
                    setConfirmModal(true);
                  }}
                >
                  Clock out
                </button>
              )}
              {confirmModal && (
                <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-9999">
                  <div className="bg-gray-800 p-5 rounded w-full max-w-sm">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-center">
                        Are you sure you want to clock out?
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
                        await window.api.shifts.clockOut(user.id);
                        setHasOpen(false);
                        setUser(null);
                        navigate('/');
                      }}
                    >
                      Clock out
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <nav className="flex items-center gap-2 sm:gap-4 min-w-0">
          {user && (
            <div
              className={`text-xs px-2 py-1 rounded border ${
                !syncOk
                  ? 'bg-rose-900/30 border-rose-800 text-rose-100'
                  : queued > 0
                    ? 'bg-amber-900/30 border-amber-800 text-amber-100'
                    : 'bg-emerald-900/30 border-emerald-800 text-emerald-100'
              }`}
              title={
                !syncOk
                  ? 'Offline / cannot reach host'
                  : queued > 0
                    ? 'Syncing queued actions'
                    : 'All synced'
              }
            >
              {!syncOk
                ? 'Offline'
                : queued > 0
                  ? `Syncing (${queued})`
                  : 'Online'}
            </div>
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
              className="p-2 rounded hover:bg-gray-700 cursor-pointer"
              aria-label="Notifications"
              onClick={() => setShowNotifications((v) => !v)}
              type="button"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-5 h-5"
              >
                <path d="M12 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 006 14h12a1 1 0 00.707-1.707L18 11.586V8a6 6 0 00-6-6zm0 20a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] px-1 rounded-full">
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
                    <div className="font-semibold">Notifications</div>
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
                        Mark all as read
                      </button>
                    )}
                  </div>
                  {user ? (
                    <NotificationsList
                      userId={user.id}
                      onCount={(n) => setUnreadCount(n)}
                    />
                  ) : (
                    <div className="opacity-70">No notifications</div>
                  )}
                  {user && <OwnerRequests userId={user.id} />}
                </div>
              </div>
            )}
          </div>

          {/* Scrollable links (only the links scroll, not the popovers) */}
          <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto whitespace-nowrap min-w-0">
            <NavLink
              to="/app/clock"
              className={({ isActive }) =>
                isActive ? 'underline' : 'hover:underline'
              }
            >
              Clock
            </NavLink>
            {!clockOnly && (
              <>
                <NavLink
                  to="/app/tables"
                  className={({ isActive }) =>
                    isActive ? 'underline' : 'hover:underline'
                  }
                >
                  Tables
                </NavLink>
                <NavLink
                  to="/app/reports"
                  className={({ isActive }) =>
                    isActive ? 'underline' : 'hover:underline'
                  }
                >
                  Reports
                </NavLink>
              </>
            )}
            {user && (
              <button
                className="ml-1 px-3 py-1 rounded-full bg-red-700 hover:bg-red-800 cursor-pointer text-sm"
                onClick={() => {
                  setUser(null);
                  navigate('/');
                }}
                type="button"
              >
                Logout
              </button>
            )}
          </div>
        </nav>
      </header>
      <main className="flex-1 p-2 sm:p-4 min-h-0 overflow-hidden">
        <Outlet />
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
    (async () => {
      const all = await window.api.notifications.list(userId).catch(() => []);
      setItems(all);
      const unreadCount = Array.isArray(all)
        ? all.filter((n: any) => !n?.readAt).length
        : 0;
      onCount(unreadCount);
    })();
  }, [userId, onCount]);
  const filtered = items.filter(
    (n) => !/requested to add items/i.test(n.message),
  );
  if (!filtered.length)
    return <div className="opacity-70">No notifications</div>;
  return (
    <ul className="max-h-72 overflow-auto space-y-2">
      {filtered.map((n) => (
        <li key={n.id} className="p-2 rounded bg-gray-700/60">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-70">
              {formatNotificationTimestamp(n.createdAt)}
            </span>
            {!n.readAt && (
              <span className="text-[10px] bg-blue-600 rounded px-1">New</span>
            )}
          </div>
          <div className="mt-1">{n.message}</div>
        </li>
      ))}
    </ul>
  );
}

function OwnerRequests({ userId }: { userId: number }) {
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
    (async () => {
      const r = await window.api.requests.listForOwner(userId).catch(() => []);
      setRows(r);
    })();
  }, [userId]);
  if (!rows.length) return null;
  return (
    <div className="mt-3 border-t border-gray-700 pt-2 max-h-64 overflow-auto">
      <div className="text-xs opacity-70 mb-1">Order requests</div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="p-2 rounded bg-gray-700/60">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                {r.area} {r.tableLabel} – Request #{r.id}
              </div>
              <span className="text-xs opacity-70">
                {formatNotificationTimestamp(r.createdAt)}
              </span>
            </div>
            {r.note && <div className="text-xs opacity-70 mt-1">{r.note}</div>}
            <div className="mt-2 text-xs">
              {Array.isArray(r.items) && r.items.length ? (
                <ul className="list-disc ml-4 space-y-0.5">
                  {r.items.map((it: any, idx: number) => (
                    <li key={idx}>
                      {String(it.name || 'Item')} ×{Number(it.qty || 1)}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="opacity-70">No items</div>
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
                Prano
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
                Refuzo
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatNotificationTimestamp(iso: string): string {
  const createdAt = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - createdAt);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `${minutes}m ago`;
  }
  if (diffMs < dayMs) {
    const hours = Math.max(1, Math.floor(diffMs / hourMs));
    return `${hours}h ago`;
  }
  if (diffMs < weekMs) {
    const days = Math.max(1, Math.floor(diffMs / dayMs));
    return `${days}d ago`;
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
