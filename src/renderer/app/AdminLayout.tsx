import { Link, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';

export default function AdminLayout() {
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    (async () => {
      const unread = await window.api.admin.listNotifications({ onlyUnread: true }).catch(() => []);
      setUnreadCount(unread.length || 0);
    })();
  }, []);
  return (
    <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
      <header className="bg-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="font-semibold">Ullishtja POS Admin</div>
        <nav className="space-x-3 text-sm flex items-center">
          <Link to="/admin" className="hover:underline">Overview</Link>
          <Link to="/admin/tickets" className="hover:underline">Tickets</Link>
          <Link to="/admin/settings" className="hover:underline">Settings</Link>

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
        </nav>
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


