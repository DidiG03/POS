import { useEffect, useMemo, useState } from 'react';
import { useAdminSessionStore } from '../../stores/adminSession';

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
  const [topSelling, setTopSelling] = useState<{ name: string; qty: number; revenue: number } | null>(null);
  const [users, setUsers] = useState<{ id: number; displayName: string; role: string; active: boolean; createdAt: string }[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [showAdmins, setShowAdmins] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createRole, setCreateRole] = useState<'WAITER' | 'CASHIER' | 'ADMIN'>('WAITER');
  const [createPin, setCreatePin] = useState('');
  const [createActive, setCreateActive] = useState(true);
  const [staffStatus, setStaffStatus] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'cloud' | 'local'>('local');
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const me = useAdminSessionStore((s) => s.user);
  // Simplified view: hide sales trends entirely

  const myId = me?.id ?? null;

  useEffect(() => {
    (async () => {
      setAdminNotice(null);
      try {
        const s = await window.api.settings.get().catch(() => null as any);
        const backendUrl = String((s as any)?.cloud?.backendUrl || '').trim();
        const businessCode = String((s as any)?.cloud?.businessCode || '').trim();
        setDataSource(backendUrl && businessCode ? 'cloud' : 'local');
        if (backendUrl && !businessCode) {
          setAdminNotice('Cloud is enabled but Business code is missing. Set it in Settings → Cloud (Hosted).');
          setOv(null);
          setShifts([]);
          setTopSelling(null);
          setUsers([]);
          return;
        }
      } catch {
        // ignore
      }

      // When cloud is enabled, require an ADMIN session before loading admin data.
      if (dataSource === 'cloud' && (!me || me.role !== 'ADMIN')) {
        setAdminNotice('Admin login required. Please login with an ADMIN account from the main login screen.');
        setOv(null);
        setShifts([]);
        setTopSelling(null);
        setUsers([]);
        return;
      }

      try {
        const data = await window.api.admin.getOverview();
        setOv(data);
      } catch (e: any) {
        setAdminNotice(e?.message || 'Failed to load admin overview.');
        setOv(null);
      }
      try {
        const sh = await window.api.admin.listShifts();
        setShifts(sh);
      } catch {
        setShifts([]);
      }
      try {
        const top = await window.api.admin.getTopSellingToday();
        setTopSelling(top);
      } catch {
        setTopSelling(null);
      }
      try {
        const u = await window.api.auth.listUsers();
        setUsers(u);
      } catch {
        setUsers([]);
      }
    })();
  }, [dataSource, me?.id, me?.role]);

  // Removed sales trends fetch for simplified overview
  const openUserIds = useMemo(() => new Set(shifts.filter((s) => s.isOpen).map((s) => s.userId)), [shifts]);
  const staffList = useMemo(() => {
    return users
      .filter((u) => (showAdmins ? true : u.role !== 'ADMIN'))
      .filter((u) => (showInactive ? true : u.active))
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
        // Keep active first, then by name
        if (a.active !== b.active) return a.active ? -1 : 1;
        return String(a.displayName || '').localeCompare(String(b.displayName || ''));
      });
  }, [showAdmins, showInactive, userQuery, users]);

  async function refreshUsers() {
    setUsers(await window.api.auth.listUsers());
  }

  return (
    <div className="grid gap-4 grid-cols-2">
      {adminNotice && (
        <div className="bg-amber-900/30 border border-amber-700 text-amber-200 rounded p-3 col-span-2 text-sm">
          {adminNotice}
        </div>
      )}
      <div className="grid gap-4 grid-cols-3">        
        <Stat title="Active Users" value={ov?.activeUsers} />
        <Stat title="Open Shifts" value={ov?.openShifts} />
        <Stat title="Open Orders" value={ov?.openOrders} />
        <Stat title="Revenue Today (net)" value={ov ? (ov.revenueTodayNet ?? 0) : '—'} />
        <Stat title="VAT Today" value={ov ? (ov.revenueTodayVat ?? 0) : '—'} />
        <div className="bg-gray-800 rounded p-4">
          <div className="text-sm opacity-70">Top Selling Today</div>
          <div className="mt-1 text-lg font-semibold">{topSelling ? topSelling.name : '—'}</div>
          {topSelling && (
            <div className="text-sm opacity-80">Qty: {topSelling.qty} • Revenue: {topSelling.revenue}</div>
          )}
        </div>
      </div>
      <div className="bg-gray-800 rounded p-4 col-span-1">
        <div className="text-sm opacity-70 mb-2">Open Shifts</div>
        <div className="grid grid-cols-4 gap-4">
          {shifts.filter((s) => s.isOpen).length === 0 && (
            <div className="opacity-70">No open shifts</div>
          )}
          {shifts.filter((s) => s.isOpen).map((s) => (
            <div key={s.id} className="bg-gray-900 rounded p-3">
              <div className="text-lg font-semibold">{s.userName}</div>
              <div className="text-sm opacity-80">Opened: {new Date(s.openedAt).toLocaleTimeString()}</div>
              <div className="text-sm">Hours: {s.durationHours}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-gray-800 rounded p-4 col-span-2">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <div className="text-sm opacity-70">Staff members</div>
            <div className="text-xs opacity-70">Loaded from {dataSource === 'cloud' ? 'cloud database' : 'local database'}</div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs opacity-80 flex items-center gap-2 select-none">
              <input type="checkbox" checked={showAdmins} onChange={(e) => setShowAdmins(e.target.checked)} />
              Show admins
            </label>
            <label className="text-xs opacity-80 flex items-center gap-2 select-none">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
              onClick={refreshUsers}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="bg-gray-900/60 border border-gray-700 rounded p-3 mb-3">
          <div className="text-sm font-semibold mb-2">Add staff member</div>
          <div className="grid grid-cols-4 gap-2">
            <input
              className="bg-gray-700 rounded px-3 py-2 col-span-2"
              placeholder="Full name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
            <select
              className="bg-gray-700 rounded px-3 py-2"
              value={createRole}
              onChange={(e) => setCreateRole(e.target.value as any)}
            >
              <option value="WAITER">WAITER</option>
              <option value="CASHIER">CASHIER</option>
              <option value="ADMIN">ADMIN</option>
            </select>
            <input
              className="bg-gray-700 rounded px-3 py-2"
              placeholder="PIN (4-6 digits)"
              inputMode="numeric"
              value={createPin}
              onChange={(e) => setCreatePin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <label className="text-xs opacity-80 flex items-center gap-2 select-none">
              <input type="checkbox" checked={createActive} onChange={(e) => setCreateActive(e.target.checked)} />
              Active
            </label>
            <button
              className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 text-sm"
              onClick={async () => {
                setStaffStatus(null);
                try {
                  const name = createName.trim();
                  if (!name) throw new Error('name is required');
                  if (createPin.length < 4) throw new Error('PIN must be 4-6 digits');
                  await window.api.auth.createUser({ displayName: name, role: createRole, pin: createPin, active: createActive } as any);
                  setCreateName('');
                  setCreatePin('');
                  setCreateRole('WAITER');
                  setCreateActive(true);
                  setStaffStatus('Created.');
                  await refreshUsers();
                } catch (e: any) {
                  setStaffStatus(e?.message || 'Failed to create user');
                }
              }}
            >
              Add
            </button>
          </div>
          {staffStatus && <div className="text-xs opacity-80 mt-2">{staffStatus}</div>}
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
                <th className="py-1 pr-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {staffList.length === 0 && (
                <tr className="border-t border-gray-700">
                  <td className="py-2 opacity-70" colSpan={7}>
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
                  <td className="py-1 pr-2">
                    <div className="flex items-center gap-2">
                      {u.active ? (
                        <button
                          className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-40"
                          disabled={myId === u.id}
                          title={myId === u.id ? 'You cannot disable your own account' : 'Disable user'}
                          onClick={async () => {
                            setStaffStatus(null);
                            try {
                              await window.api.auth.updateUser({ id: u.id, active: false } as any);
                              await refreshUsers();
                            } catch (e: any) {
                              setStaffStatus(e?.message || 'Failed to disable user');
                            }
                          }}
                        >
                          Disable
                        </button>
                      ) : (
                        <button
                          className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs"
                          onClick={async () => {
                            setStaffStatus(null);
                            try {
                              await window.api.auth.updateUser({ id: u.id, active: true } as any);
                              await refreshUsers();
                            } catch (e: any) {
                              setStaffStatus(e?.message || 'Failed to enable user');
                            }
                          }}
                        >
                          Enable
                        </button>
                      )}

                      <button
                        className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-xs disabled:opacity-40"
                        disabled={myId === u.id}
                        title={myId === u.id ? 'You cannot delete your own account' : 'Permanently delete user (only if no history)'}
                        onClick={async () => {
                          if (myId === u.id) return;
                          const ok = window.confirm(`Permanently delete "${u.displayName}" (ID ${u.id})? This only works if they have no history.`);
                          if (!ok) return;
                          setStaffStatus(null);
                          try {
                            await window.api.auth.deleteUser({ id: u.id, hard: true } as any);
                            setStaffStatus('Deleted.');
                            await refreshUsers();
                          } catch (e: any) {
                            setStaffStatus(e?.message || 'Failed to delete user');
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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


