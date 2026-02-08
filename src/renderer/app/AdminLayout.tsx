import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { useAdminSessionStore } from '../stores/adminSession';

function IconOverview() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M4 13.5V20h6v-6.5H4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M14 4v16h6V4h-6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M4 10V4h6v6H4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTickets() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M7 4h10a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V6a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M9 8h6M9 12h6M9 16h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMenu() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M5 6h14M5 12h14M5 18h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M19.4 15a8.2 8.2 0 0 0 .1-6l-2.1.3a6.7 6.7 0 0 0-1.1-1.1l.3-2.1a8.2 8.2 0 0 0-6-.1l.3 2.1c-.4.3-.8.6-1.1 1.1L7.6 9a8.2 8.2 0 0 0-.1 6l2.1-.3c.3.4.6.8 1.1 1.1l-.3 2.1a8.2 8.2 0 0 0 6 .1l-.3-2.1c.4-.3.8-.6 1.1-1.1l2.2.3Z"
        stroke="currentColor"
        strokeWidth="2"
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
      className="w-4 h-4"
      aria-hidden
    >
      <path
        d="M10 7V5a2 2 0 0 1 2-2h7v18h-7a2 2 0 0 1-2-2v-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M13 12H3m0 0 3-3M3 12l3 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function AdminLayout() {
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
        setNetOk(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
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
    const t = window.setInterval(tick, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const connectivity = useMemo(() => {
    if (!netOk || !backendOk) return { label: 'Poor', cls: 'bg-rose-900/30 border-rose-800 text-rose-100' };
    const dt = latencyMs ?? 0;
    if (dt >= 900) return { label: 'Poor', cls: 'bg-rose-900/30 border-rose-800 text-rose-100' };
    if (dt >= 300) return { label: 'Good', cls: 'bg-amber-900/30 border-amber-800 text-amber-100' };
    return { label: 'Great', cls: 'bg-emerald-900/30 border-emerald-800 text-emerald-100' };
  }, [netOk, backendOk, latencyMs]);
  useEffect(() => {
    (async () => {
      if (!me || me.role !== 'ADMIN') {
        setUnreadCount(0);
        return;
      }
      const unread = await window.api.admin.listNotifications({ onlyUnread: true }).catch(() => []);
      setUnreadCount(unread.length || 0);
    })();
  }, [me?.id, me?.role]);
  return (
    <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
      <header className="bg-gray-800 px-3 sm:px-4 py-2.5 sm:py-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2 items-center">
        <div className="font-semibold justify-self-start"> Code Orbit POS Admin</div>

        {/* Center nav */}
        <div className="flex items-center justify-start sm:justify-center min-w-0">
          <nav className="text-sm flex items-center gap-2 sm:gap-3 overflow-x-auto whitespace-nowrap">
          <NavLink
            to="/admin"
            end
            className={({ isActive }) =>
              `px-2 py-1 rounded flex items-center gap-1.5 ${isActive ? 'bg-gray-700/70' : 'hover:bg-gray-700/50'}`
            }
            title="Overview"
          >
            <IconOverview />
            <span className="hidden sm:inline">Overview</span>
          </NavLink>
          <NavLink
            to="/admin/tickets"
            className={({ isActive }) =>
              `px-2 py-1 rounded flex items-center gap-1.5 ${isActive ? 'bg-gray-700/70' : 'hover:bg-gray-700/50'}`
            }
            title="Tickets"
          >
            <IconTickets />
            <span className="hidden sm:inline">Tickets</span>
          </NavLink>
          <NavLink
            to="/admin/menu"
            className={({ isActive }) =>
              `px-2 py-1 rounded flex items-center gap-1.5 ${isActive ? 'bg-gray-700/70' : 'hover:bg-gray-700/50'}`
            }
            title="Menu"
          >
            <IconMenu />
            <span className="hidden sm:inline">Menu</span>
          </NavLink>
          <NavLink
            to="/admin/settings"
            className={({ isActive }) =>
              `px-2 py-1 rounded flex items-center gap-1.5 ${isActive ? 'bg-gray-700/70' : 'hover:bg-gray-700/50'}`
            }
            title="Settings"
          >
            <IconSettings />
            <span className="hidden sm:inline">Settings</span>
          </NavLink>
          </nav>
        </div>

        {/* Right utilities */}
        <div className="flex items-center gap-2 sm:gap-3 justify-start sm:justify-end min-w-0">

          <div
            className={`text-xs px-2 py-1 rounded border ${connectivity.cls}`}
            title={
              !netOk
                ? 'Offline'
                : !backendOk
                  ? 'Cannot reach POS backend'
                  : `Latency: ${latencyMs ?? 0}ms${checkedAt ? ` • Last checked: ${new Date(checkedAt).toLocaleTimeString()}` : ''}`
            }
          >
            {connectivity.label}
          </div>

          <div className="relative inline-block">
            <button
              className="px-2 py-1 rounded hover:bg-gray-700"
              aria-label="Notifications"
              onClick={() => setShowNotifications((v) => !v)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M12 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 006 14h12a1 1 0 00.707-1.707L18 11.586V8a6 6 0 00-6-6zm0 20a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
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
                    <div className="font-semibold">Notifications</div>
                    {unreadCount > 0 && (
                      <button
                        className="text-xs text-blue-400 hover:underline"
                        onClick={async () => {
                          await window.api.admin.markAllNotificationsRead().catch(() => {});
                          setUnreadCount(0);
                        }}
                      >
                        Mark all as read
                      </button>
                    )}
                  </div>
                  <AdminNotificationsList onCount={(n) => setUnreadCount(n)} />
                </div>
              </div>
            )}
          </div>
          <button
            className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 flex items-center gap-2"
            onClick={async () => {
              // Clear persisted admin session so reopening /admin requires PIN again.
              setMe(null as any);
              // Clear cloud admin token in main process (Electron) and force this window back to login.
              await window.api.auth.logoutAdmin().catch(() => {});
              setShowNotifications(false);
              setUnreadCount(0);
              navigate('/admin');
            }}
            title="Logout"
          >
            <IconLogout />
            <span className="hidden sm:inline">Logout</span>
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
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}

function AdminNotificationsList({ onCount }: { onCount: (n: number) => void }) {
  const [items, setItems] = useState<{ id: number; userId: number; userName: string; type: string; message: string; readAt: string | null; createdAt: string }[]>([]);
  useEffect(() => {
    (async () => {
      const all = await window.api.admin.listNotifications({}).catch(() => []);
      setItems(all);
      const unread = await window.api.admin.listNotifications({ onlyUnread: true }).catch(() => []);
      onCount(unread.length || 0);
    })();
  }, [onCount]);
  if (!items.length) return <div className="opacity-70">No notifications</div>;
  return (
    <ul className="max-h-80 overflow-auto space-y-2">
      {items.map((n) => (
        <li key={n.id} className="p-2 rounded bg-gray-700/60">
          <div className="text-xs opacity-70 flex items-center justify-between">
            <span>{n.userName}</span>
            <span>{formatAdminNotificationTimestamp(n.createdAt)}</span>
          </div>
          <div className="mt-1">{n.message}</div>
        </li>
      ))}
    </ul>
  );
}

function formatAdminNotificationTimestamp(iso: string): string {
  const createdAt = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - createdAt);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  if (diffMs < hourMs) return `${Math.max(1, Math.floor(diffMs / minuteMs))}m ago`;
  if (diffMs < dayMs) return `${Math.max(1, Math.floor(diffMs / hourMs))}h ago`;
  if (diffMs < weekMs) return `${Math.max(1, Math.floor(diffMs / dayMs))}d ago`;
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yy} ${hh}-${min}-${ss}`;
}


