import { useEffect, useState } from 'react';
import { api } from '../../api';

type Overview = {
  activeUsers: number;
  openShifts: number;
  openOrders: number;
  lowStockItems: number;
  queuedPrintJobs: number;
  lastMenuSync?: string | null;
  lastStaffSync?: string | null;
  printerIp?: string | null;
  appVersion: string;
  revenueTodayNet?: number;
  revenueTodayVat?: number;
};

type AdminShift = {
  id: number;
  userId: number;
  userName: string;
  openedAt: string;
  closedAt: string | null;
  durationHours: number;
  isOpen: boolean;
};

export default function AdminPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [shifts, setShifts] = useState<AdminShift[]>([]);
  const [sortKey, setSortKey] = useState<'userName' | 'openedAt' | 'durationHours'>('openedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [topSelling, setTopSelling] = useState<{ name: string; qty: number; revenue: number } | null>(null);
  const [users, setUsers] = useState<{ id: number; displayName: string; role: string; active: boolean; createdAt: string }[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [showAdmins, setShowAdmins] = useState(false);
  const [trendRange, setTrendRange] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [trend, setTrend] = useState<{ label: string; total: number; orders: number }[]>([]);

  useEffect(() => {
    (async () => {
      const data = await api.admin.getOverview();
      setOv(data);
      await api.settings.get();
      const sh = await api.admin.listShifts();
      setShifts(sh);
      const top = await api.admin.getTopSellingToday();
      setTopSelling(top as any);
      const u = await api.auth.listUsers();
      setUsers(u);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const t = await api.admin.getSalesTrends({ range: trendRange });
      setTrend(((t as any)?.points || t || []) as any);
    })();
  }, [trendRange]);

  const openUserIds = new Set(shifts.filter((s) => s.isOpen).map((s) => s.userId));
  const staffList = users
    .filter((u) => (showAdmins ? true : u.role !== 'ADMIN'))
    .filter((u) => {
      const q = userQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        String(u.displayName || '').toLowerCase().includes(q) ||
        String(u.role || '').toLowerCase().includes(q) ||
        String(u.id).includes(q)
      );
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return String(a.displayName || '').localeCompare(String(b.displayName || ''));
    });

  return (
    <div className="grid gap-4 grid-cols-3">
      <Stat title="Active Users" value={ov?.activeUsers} />
      <Stat title="Open Shifts" value={ov?.openShifts} />
      <Stat title="Open Orders" value={ov?.openOrders} />
      <Stat title="Revenue Today (net)" value={ov ? (ov.revenueTodayNet ?? 0).toFixed(2) : '—'} />
      <Stat title="VAT Today" value={ov ? (ov.revenueTodayVat ?? 0).toFixed(2) : '—'} />
      <div className="bg-gray-800 rounded p-4">
        <div className="text-sm opacity-70">Top Selling Today</div>
        <div className="mt-1 text-lg font-semibold">{topSelling ? topSelling.name : '—'}</div>
        {topSelling && (
          <div className="text-sm opacity-80">Qty: {topSelling.qty} • Revenue: {topSelling.revenue.toFixed(2)}</div>
        )}
      </div>
      <Stat title="Low Stock Items" value={ov?.lowStockItems} />
      {/* <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="text-sm opacity-70">System</div>
        <div className="mt-2 grid grid-cols-3 gap-4 text-sm">
          <div>Last Menu Sync: {ov?.lastMenuSync ?? '—'}</div>
          <div>Last Staff Sync: {ov?.lastStaffSync ?? '—'}</div>
          <div>Printer IP: {ov?.printerIp ?? '—'}</div>
        </div>
        <div className="mt-2 text-xs opacity-70">App v{ov?.appVersion}</div>
      </div> */}
      <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="text-sm opacity-70 mb-2">Shifts</div>
        <div className="overflow-auto max-h-72">
          <table className="w-full text-sm">
            <thead className="text-left opacity-70">
              <tr>
                <th
                  className="py-1 pr-2 cursor-pointer select-none"
                  onClick={() => {
                    setSortKey('userName');
                    setSortDir((d) => (sortKey === 'userName' ? (d === 'asc' ? 'desc' : 'asc') : 'asc'));
                  }}
                >
                  User {sortKey === 'userName' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th
                  className="py-1 pr-2 cursor-pointer select-none"
                  onClick={() => {
                    setSortKey('openedAt');
                    setSortDir((d) => (sortKey === 'openedAt' ? (d === 'asc' ? 'desc' : 'asc') : 'desc'));
                  }}
                >
                  Opened {sortKey === 'openedAt' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th className="py-1 pr-2">Closed</th>
                <th
                  className="py-1 pr-2 cursor-pointer select-none"
                  onClick={() => {
                    setSortKey('durationHours');
                    setSortDir((d) => (sortKey === 'durationHours' ? (d === 'asc' ? 'desc' : 'asc') : 'desc'));
                  }}
                >
                  Hours {sortKey === 'durationHours' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th className="py-1 pr-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...shifts]
                .sort((a, b) => {
                  const dir = sortDir === 'asc' ? 1 : -1;
                  if (sortKey === 'userName') return a.userName.localeCompare(b.userName) * dir;
                  if (sortKey === 'durationHours') return (a.durationHours - b.durationHours) * dir;
                  // openedAt
                  return (new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()) * dir;
                })
                .map((s) => (
                <tr key={s.id} className="border-t border-gray-700">
                  <td className="py-1 pr-2">{s.userName}</td>
                  <td className="py-1 pr-2">{new Date(s.openedAt).toLocaleString()}</td>
                  <td className="py-1 pr-2">{s.closedAt ? new Date(s.closedAt).toLocaleString() : '—'}</td>
                  <td className="py-1 pr-2">{s.durationHours.toFixed(2)}</td>
                  <td className="py-1 pr-2">{s.isOpen ? 'Open' : 'Closed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <div className="text-sm opacity-70">Staff members</div>
            <div className="text-xs opacity-70">Loaded from database</div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs opacity-80 flex items-center gap-2 select-none">
              <input type="checkbox" checked={showAdmins} onChange={(e) => setShowAdmins(e.target.checked)} />
              Show admins
            </label>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
              onClick={async () => setUsers(await api.auth.listUsers())}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mb-3">
          <input
            className="w-full bg-gray-700 rounded px-3 py-2"
            placeholder="Search by name, role, or ID…"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
          />
        </div>

        <div className="overflow-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="text-left opacity-70">
              <tr>
                <th className="py-1 pr-2">ID</th>
                <th className="py-1 pr-2">Name</th>
                <th className="py-1 pr-2">Role</th>
                <th className="py-1 pr-2">Active</th>
                <th className="py-1 pr-2">On shift</th>
                <th className="py-1 pr-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {staffList.length === 0 && (
                <tr className="border-t border-gray-700">
                  <td className="py-2 opacity-70" colSpan={6}>
                    No staff found
                  </td>
                </tr>
              )}
              {staffList.map((u) => (
                <tr key={u.id} className="border-t border-gray-700">
                  <td className="py-1 pr-2 opacity-80">{u.id}</td>
                  <td className="py-1 pr-2">{u.displayName}</td>
                  <td className="py-1 pr-2">
                    <span className="px-2 py-0.5 rounded bg-gray-900/70 border border-gray-700">
                      {u.role}
                    </span>
                  </td>
                  <td className="py-1 pr-2">{u.active ? 'Yes' : 'No'}</td>
                  <td className="py-1 pr-2">{openUserIds.has(u.id) ? 'Yes' : 'No'}</td>
                  <td className="py-1 pr-2 opacity-80">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-gray-800 rounded p-4 col-span-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm opacity-70">Sales Trends</div>
          <div className="bg-gray-700 rounded overflow-hidden text-xs">
            {(['daily','weekly','monthly'] as const).map((r) => (
              <button key={r} onClick={() => setTrendRange(r)} className={`px-3 py-1 ${trendRange===r?'bg-gray-600':''}`}>{r}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6">
          <Chart title="Revenue" points={trend.map(p => ({ label: p.label, value: p.total }))} />
          <Chart title="Orders" points={trend.map(p => ({ label: p.label, value: p.orders }))} />
        </div>
      </div>
    </div>
  );
}

function Stat({ title, value }: { title: string; value: any }) {
  return (
    <div className="bg-gray-800 rounded p-4">
      <div className="text-sm opacity-70">{title}</div>
      <div className="text-2xl font-semibold mt-1">{value ?? '—'}</div>
    </div>
  );
}

function Chart({ title, points }: { title: string; points: { label: string; value: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="bg-gray-900 rounded p-3">
      <div className="text-sm opacity-70 mb-2">{title}</div>
      <div className="h-40 flex items-end gap-1">
        {points.map((p, i) => (
          <div key={i} className="flex-1 flex flex-col items-center">
            <div className="w-full bg-emerald-600" style={{ height: `${(p.value / max) * 100}%` }} />
            <div className="mt-1 text-[10px] opacity-70 truncate w-full text-center">{p.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}


