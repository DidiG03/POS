import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/session';
import { useTableStatus } from '../stores/tableStatus';
import { api } from '../api';

export default function AppLayout() {
  const { user, setUser } = useSessionStore();
  const [hasOpen, setHasOpen] = useState<boolean>(false);
  const [showNotifications, setShowNotifications] = useState<boolean>(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      if (!user) return;
      const open = await api.shifts.getOpen(user.id);
      setHasOpen(Boolean(open));
      const notifs = await api.notifications.list(user.id, true).catch(() => []);
      setUnreadCount(notifs.length || 0);
    })();
  }, [user]);
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="font-semibold">Ullishtja Agrotourizem</div>
        <nav className="space-x-4 flex items-center">
          <Link to="/app" className="hover:underline">Home</Link>
          <Link to="/app/tables" className="hover:underline">Tables</Link>
          <Link to="/app/order" className="hover:underline">Order</Link>
          <Link to="/app/reports" className="hover:underline">Reports</Link>
          <Link to="/app/settings" className="hover:underline">Settings</Link>

          {/* Notification bell */}
          <div className="relative inline-block">
            <button
              className="ml-2 p-2 rounded hover:bg-gray-700"
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
              <div className="absolute right-0 mt-2 w-72 bg-gray-800 rounded border border-gray-700 shadow-lg z-50">
                <div className="p-3 text-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold">Notifications</div>
                    {user && unreadCount > 0 && (
                      <button
                        className="text-xs text-blue-400 hover:underline"
                        onClick={async () => {
                          await api.notifications.markAllRead(user.id).catch(() => {});
                          setUnreadCount(0);
                        }}
                      >
                        Mark all as read
                      </button>
                    )}
                  </div>
                  {user ? (
                    <NotificationsList userId={user.id} onCount={(n) => setUnreadCount(n)} />
                  ) : (
                    <div className="opacity-70">No notifications</div>
                  )}
                </div>
              </div>
            )}
          </div>
          {user && (
            <>
              {hasOpen && (
                <button
                  className="ml-4 px-3 py-1 rounded bg-red-600 hover:bg-red-700"
                  onClick={async () => {
                    const { openMap } = useTableStatus.getState();
                    const anyOpen = Object.values(openMap).some(Boolean);
                    if (anyOpen) {
                      alert('Cannot clock out while there are open tables. Please settle all tickets first.');
                      return;
                    }
                    await api.shifts.clockOut(user.id);
                    setHasOpen(false);
                    setUser(null);
                    navigate('/');
                  }}
                >
                  Clock out
                </button>
              )}
              <button
                className="ml-2 px-3 py-1 rounded bg-gray-600 hover:bg-gray-700"
                onClick={() => {
                  setUser(null);
                  navigate('/');
                }}
              >
                Log out
              </button>
            </>
          )}
        </nav>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}

function NotificationsList({ userId, onCount }: { userId: number; onCount: (n: number) => void }) {
  const [items, setItems] = useState<{ id: number; type: string; message: string; readAt: string | null; createdAt: string }[]>([]);
  useEffect(() => {
    (async () => {
      const all = await api.notifications.list(userId).catch(() => []);
      setItems(all);
      const unread = await api.notifications.list(userId, true).catch(() => []);
      onCount(unread.length || 0);
    })();
  }, [userId, onCount]);
  if (!items.length) return <div className="opacity-70">No notifications</div>;
  return (
    <ul className="max-h-72 overflow-auto space-y-2">
      {items.map((n) => (
        <li key={n.id} className="p-2 rounded bg-gray-700/60">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-70">{formatNotificationTimestamp(n.createdAt)}</span>
            {!n.readAt && <span className="text-[10px] bg-blue-600 rounded px-1">NEW</span>}
          </div>
          <div className="mt-1">{n.message}</div>
        </li>
      ))}
    </ul>
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


