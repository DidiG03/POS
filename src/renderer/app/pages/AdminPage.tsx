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
  const [currency, setCurrency] = useState<string>('EUR');
  const [shifts, setShifts] = useState<AdminShift[]>([]);
  const [showShiftsModal, setShowShiftsModal] = useState(false);
  const [shiftFilter, setShiftFilter] = useState<'OPEN' | 'CLOSED' | 'ALL'>(
    'OPEN',
  );
  const [shiftQuery, setShiftQuery] = useState('');
  const [shiftView, setShiftView] = useState<'SHIFTS' | 'STAFF'>('SHIFTS');
  const [shiftRange, setShiftRange] = useState<
    'TODAY' | 'YESTERDAY' | 'WEEK' | 'MONTH' | 'ALL'
  >('TODAY');
  const [topSelling, setTopSelling] = useState<{
    name: string;
    qty: number;
    revenue: number;
  } | null>(null);
  const [users, setUsers] = useState<
    {
      id: number;
      displayName: string;
      role: string;
      active: boolean;
      createdAt: string;
    }[]
  >([]);
  const [userQuery, setUserQuery] = useState('');
  const [showAdmins, setShowAdmins] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createRole, setCreateRole] = useState<
    | 'WAITER'
    | 'CASHIER'
    | 'ADMIN'
    | 'KP'
    | 'CHEF'
    | 'HEAD_CHEF'
    | 'FOOD_RUNNER'
    | 'HOST'
    | 'BUSSER'
    | 'BARTENDER'
    | 'BARBACK'
    | 'CLEANER'
  >('WAITER');
  const [createPin, setCreatePin] = useState('');
  const [createActive, setCreateActive] = useState(true);
  const [staffStatus, setStaffStatus] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'cloud' | 'local'>('local');
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [billingPaused, setBillingPaused] = useState(false);
  const me = useAdminSessionStore((s) => s.user);
  // Simplified view: hide sales trends entirely

  const myId = me?.id ?? null;

  useEffect(() => {
    (async () => {
      setAdminNotice(null);
      try {
        const s = await window.api.settings.get().catch(() => null as any);
        const backendUrl = String((s as any)?.cloud?.backendUrl || '').trim();
        const businessCode = String(
          (s as any)?.cloud?.businessCode || '',
        ).trim();
        const cur = String((s as any)?.currency || '').trim();
        if (cur) setCurrency(cur);
        setDataSource(backendUrl && businessCode ? 'cloud' : 'local');
        if (backendUrl && !businessCode) {
          setAdminNotice(
            'Cloud is enabled but Business code is missing. Set it in Settings → Cloud (Hosted).',
          );
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
        setAdminNotice(
          'Admin login required. Please login with an ADMIN account from the main login screen.',
        );
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

      try {
        const b = await (window.api as any).billing?.getStatus?.();
        const enabled = Boolean((b as any)?.billingEnabled);
        const st = String((b as any)?.status || 'ACTIVE').toUpperCase();
        setBillingPaused(enabled && (st === 'PAST_DUE' || st === 'PAUSED'));
      } catch {
        setBillingPaused(false);
      }
    })();
  }, [dataSource, me?.id, me?.role]);

  // Removed sales trends fetch for simplified overview
  const openUserIds = useMemo(
    () => new Set(shifts.filter((s) => s.isOpen).map((s) => s.userId)),
    [shifts],
  );
  const staffList = useMemo(() => {
    return users
      .filter((u) => (showAdmins ? true : u.role !== 'ADMIN'))
      .filter((u) => (showInactive ? true : u.active))
      .filter((u) => {
        const q = userQuery.trim().toLowerCase();
        if (!q) return true;
        return (
          String(u.displayName || '')
            .toLowerCase()
            .includes(q) ||
          String(u.role || '')
            .toLowerCase()
            .includes(q) ||
          String(u.id).includes(q)
        );
      })
      .sort((a, b) => {
        // Keep active first, then by name
        if (a.active !== b.active) return a.active ? -1 : 1;
        return String(a.displayName || '').localeCompare(
          String(b.displayName || ''),
        );
      });
  }, [showAdmins, showInactive, userQuery, users]);

  async function refreshUsers() {
    setUsers(await window.api.auth.listUsers());
  }

  function computeRangeIso(): { startIso?: string; endIso?: string } {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    if (shiftRange === 'TODAY')
      return {
        startIso: startOfToday.toISOString(),
        endIso: endOfToday.toISOString(),
      };
    if (shiftRange === 'YESTERDAY') {
      const s = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
      const e = new Date(endOfToday.getTime() - 24 * 60 * 60 * 1000);
      return { startIso: s.toISOString(), endIso: e.toISOString() };
    }
    if (shiftRange === 'WEEK') {
      const s = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
      return { startIso: s.toISOString(), endIso: endOfToday.toISOString() };
    }
    if (shiftRange === 'MONTH') {
      const s = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { startIso: s.toISOString(), endIso: endOfToday.toISOString() };
    }
    return {};
  }

  async function refreshShifts() {
    try {
      const range = computeRangeIso();
      const sh = await window.api.admin.listShifts(range);
      setShifts(sh);
    } catch {
      setShifts([]);
    }
  }

  // Keep shift history accurate: refresh on open, and lightly poll while the modal is open.
  useEffect(() => {
    if (!showShiftsModal) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refreshShifts();
    };
    void tick();
    const t = window.setInterval(() => void tick(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [showShiftsModal, shiftRange]);

  const openShiftCount = useMemo(
    () => shifts.filter((s) => s.isOpen).length,
    [shifts],
  );
  const closedShiftCount = useMemo(
    () => shifts.filter((s) => !s.isOpen).length,
    [shifts],
  );
  const filteredShifts = useMemo(() => {
    const q = shiftQuery.trim().toLowerCase();
    return shifts
      .filter((s) =>
        shiftFilter === 'ALL'
          ? true
          : shiftFilter === 'OPEN'
            ? s.isOpen
            : !s.isOpen,
      )
      .filter((s) => {
        if (!q) return true;
        return (
          String(s.userName || '')
            .toLowerCase()
            .includes(q) ||
          String(s.userId).includes(q) ||
          String(s.id).includes(q)
        );
      })
      .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
  }, [shiftFilter, shiftQuery, shifts]);

  const staffShiftSummary = useMemo(() => {
    const byUser = new Map<
      number,
      {
        userId: number;
        userName: string;
        openCount: number;
        closedCount: number;
        totalHours: number;
        lastOpenedAt: string | null;
        lastClosedAt: string | null;
      }
    >();
    for (const s of shifts) {
      const row = byUser.get(s.userId) ?? {
        userId: s.userId,
        userName: s.userName,
        openCount: 0,
        closedCount: 0,
        totalHours: 0,
        lastOpenedAt: null,
        lastClosedAt: null,
      };
      if (s.isOpen) row.openCount += 1;
      else row.closedCount += 1;
      const h = Number(s.durationHours || 0);
      row.totalHours += Number.isFinite(h) ? h : 0;
      if (!row.lastOpenedAt || String(s.openedAt) > String(row.lastOpenedAt))
        row.lastOpenedAt = s.openedAt;
      if (
        s.closedAt &&
        (!row.lastClosedAt || String(s.closedAt) > String(row.lastClosedAt))
      )
        row.lastClosedAt = s.closedAt;
      byUser.set(s.userId, row);
    }
    return Array.from(byUser.values()).sort(
      (a, b) =>
        b.totalHours - a.totalHours ||
        String(a.userName).localeCompare(String(b.userName)),
    );
  }, [shifts]);

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
        <Stat
          title="Revenue Today (net)"
          value={ov ? (ov.revenueTodayNet ?? 0) : null}
          kind="money"
          currency={currency}
        />
        <Stat
          title="VAT Today"
          value={ov ? (ov.revenueTodayVat ?? 0) : null}
          kind="money"
          currency={currency}
        />
        <div className="bg-gray-800 rounded p-4">
          <div className="text-sm opacity-70">Top Selling Today</div>
          <div className="mt-1 text-lg font-semibold">
            {topSelling ? topSelling.name : '—'}
          </div>
          {topSelling && (
            <div className="text-sm opacity-80">
              Qty: {topSelling.qty} • Revenue:{' '}
              <span className="font-semibold tabular-nums">
                {formatMoney(topSelling.revenue, currency)}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="bg-gray-800 rounded p-4 col-span-1">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="text-sm opacity-70">Open Shifts</div>
          <button
            className="text-xs px-2.5 py-1.5 rounded bg-gray-700 hover:bg-gray-600"
            onClick={() => {
              setShiftFilter('ALL');
              setShiftView('SHIFTS');
              setShiftRange('TODAY');
              setShowShiftsModal(true);
              void refreshShifts();
            }}
            type="button"
          >
            View all
          </button>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {shifts.filter((s) => s.isOpen).length === 0 && (
            <div className="opacity-70">No open shifts</div>
          )}
          {shifts
            .filter((s) => s.isOpen)
            .map((s) => (
              <div key={s.id} className="bg-gray-900 rounded p-3">
                <div className="text-lg font-semibold">{s.userName}</div>
                <div className="text-sm opacity-80">
                  Opened: {new Date(s.openedAt).toLocaleTimeString()}
                </div>
                <div className="text-sm">Hours: {s.durationHours}</div>
              </div>
            ))}
        </div>
      </div>

      {showShiftsModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-[92vw] max-w-5xl p-4">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <div className="text-lg font-semibold">Shift history</div>
                <div className="text-xs opacity-70">
                  Total: {shifts.length} • Open: {openShiftCount} • Closed:{' '}
                  {closedShiftCount}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                  onClick={refreshShifts}
                  type="button"
                >
                  Refresh
                </button>
                <button
                  className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                  onClick={() => setShowShiftsModal(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex flex-col md:flex-row md:items-center gap-2 mb-3">
              <div className="flex items-center gap-2">
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftView === 'SHIFTS' ? 'bg-blue-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftView('SHIFTS')}
                  type="button"
                >
                  Shifts
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftView === 'STAFF' ? 'bg-blue-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftView('STAFF')}
                  type="button"
                >
                  By staff
                </button>
                <div className="w-px h-7 bg-gray-700 mx-1 hidden md:block" />
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'TODAY' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('TODAY')}
                  type="button"
                >
                  Today
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'YESTERDAY' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('YESTERDAY')}
                  type="button"
                >
                  Yesterday
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'WEEK' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('WEEK')}
                  type="button"
                >
                  Week
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'MONTH' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('MONTH')}
                  type="button"
                >
                  Month
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'ALL' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('ALL')}
                  type="button"
                >
                  All time
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftFilter === 'OPEN' ? 'bg-emerald-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftFilter('OPEN')}
                  type="button"
                >
                  Open
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftFilter === 'CLOSED' ? 'bg-emerald-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftFilter('CLOSED')}
                  type="button"
                >
                  Closed
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftFilter === 'ALL' ? 'bg-emerald-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftFilter('ALL')}
                  type="button"
                >
                  All
                </button>
              </div>
              <div className="flex-1" />
              <input
                className="bg-gray-800 rounded px-3 py-2 text-sm w-full md:w-[320px]"
                placeholder="Search staff, userId, shiftId…"
                value={shiftQuery}
                onChange={(e) => setShiftQuery(e.target.value)}
              />
            </div>

            {shiftView === 'SHIFTS' ? (
              <div className="overflow-auto max-h-[70vh] border border-gray-800 rounded">
                <table className="w-full text-sm">
                  <thead className="text-left bg-gray-900 sticky top-0">
                    <tr className="opacity-70">
                      <th className="py-2 px-3">Status</th>
                      <th className="py-2 px-3">Staff</th>
                      <th className="py-2 px-3">Opened</th>
                      <th className="py-2 px-3">Closed</th>
                      <th className="py-2 px-3 text-right">Hours</th>
                      <th className="py-2 px-3 text-right">Shift ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredShifts.length === 0 && (
                      <tr className="border-t border-gray-800">
                        <td className="py-3 px-3 opacity-70" colSpan={6}>
                          No shifts found.
                        </td>
                      </tr>
                    )}
                    {filteredShifts.map((s) => (
                      <tr key={s.id} className="border-t border-gray-800">
                        <td className="py-2 px-3">
                          <span
                            className={`px-2 py-0.5 rounded border text-xs ${
                              s.isOpen
                                ? 'bg-emerald-900/30 border-emerald-700 text-emerald-100'
                                : 'bg-gray-800 border-gray-700 text-gray-200'
                            }`}
                          >
                            {s.isOpen ? 'OPEN' : 'CLOSED'}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <div className="font-medium">{s.userName}</div>
                          <div className="text-xs opacity-70">
                            User #{s.userId}
                          </div>
                        </td>
                        <td className="py-2 px-3 opacity-90">
                          {new Date(s.openedAt).toLocaleString()}
                        </td>
                        <td className="py-2 px-3 opacity-90">
                          {s.closedAt
                            ? new Date(s.closedAt).toLocaleString()
                            : '—'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {Number.isFinite(s.durationHours)
                            ? s.durationHours.toFixed(2)
                            : '—'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono opacity-80">
                          {s.id}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-auto max-h-[70vh] border border-gray-800 rounded">
                <table className="w-full text-sm">
                  <thead className="text-left bg-gray-900 sticky top-0">
                    <tr className="opacity-70">
                      <th className="py-2 px-3">Staff</th>
                      <th className="py-2 px-3 text-right">Open</th>
                      <th className="py-2 px-3 text-right">Closed</th>
                      <th className="py-2 px-3">Last opened</th>
                      <th className="py-2 px-3">Last closed</th>
                      <th className="py-2 px-3 text-right">Total hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffShiftSummary.length === 0 && (
                      <tr className="border-t border-gray-800">
                        <td className="py-3 px-3 opacity-70" colSpan={6}>
                          No shifts found.
                        </td>
                      </tr>
                    )}
                    {staffShiftSummary
                      .filter((r) => {
                        const q = shiftQuery.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          String(r.userName || '')
                            .toLowerCase()
                            .includes(q) || String(r.userId).includes(q)
                        );
                      })
                      .map((r) => (
                        <tr
                          key={r.userId}
                          className="border-t border-gray-800 hover:bg-gray-800/40 cursor-pointer"
                          onClick={() => {
                            setShiftView('SHIFTS');
                            setShiftFilter('ALL');
                            setShiftQuery(String(r.userName || r.userId));
                          }}
                        >
                          <td className="py-2 px-3">
                            <div className="font-medium">{r.userName}</div>
                            <div className="text-xs opacity-70">
                              User #{r.userId}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            {r.openCount}
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            {r.closedCount}
                          </td>
                          <td className="py-2 px-3 opacity-90">
                            {r.lastOpenedAt
                              ? new Date(r.lastOpenedAt).toLocaleString()
                              : '—'}
                          </td>
                          <td className="py-2 px-3 opacity-90">
                            {r.lastClosedAt
                              ? new Date(r.lastClosedAt).toLocaleString()
                              : '—'}
                          </td>
                          <td className="py-2 px-3 text-right font-mono">
                            {Number.isFinite(r.totalHours)
                              ? r.totalHours.toFixed(2)
                              : '—'}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 text-xs opacity-70 border-t border-gray-800">
                  Tip: click a staff row to jump to their previous shifts.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-gray-800 rounded p-4 col-span-2">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <div className="text-sm opacity-70">Staff members</div>
            <div className="text-xs opacity-70">
              Loaded from{' '}
              {dataSource === 'cloud' ? 'cloud database' : 'local database'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs opacity-80 flex items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={showAdmins}
                onChange={(e) => setShowAdmins(e.target.checked)}
              />
              Show admins
            </label>
            <label className="text-xs opacity-80 flex items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
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
          {billingPaused && (
            <div className="mb-2 text-xs text-amber-200 bg-amber-900/20 border border-amber-800 rounded p-2">
              Billing is paused. You can access the admin panel, but adding
              staff is disabled until payment is completed.
            </div>
          )}
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
              <option value="KP">KP</option>
              <option value="CHEF">CHEF</option>
              <option value="HEAD_CHEF">HEAD_CHEF</option>
              <option value="FOOD_RUNNER">FOOD_RUNNER</option>
              <option value="HOST">HOST</option>
              <option value="BUSSER">BUSSER</option>
              <option value="BARTENDER">BARTENDER</option>
              <option value="BARBACK">BARBACK</option>
              <option value="CLEANER">CLEANER</option>
            </select>
            <input
              className="bg-gray-700 rounded px-3 py-2"
              placeholder="PIN (4-6 digits)"
              inputMode="numeric"
              value={createPin}
              onChange={(e) =>
                setCreatePin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              }
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <label className="text-xs opacity-80 flex items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={createActive}
                onChange={(e) => setCreateActive(e.target.checked)}
              />
              Active
            </label>
            <button
              className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 text-sm"
              disabled={billingPaused}
              onClick={async () => {
                setStaffStatus(null);
                try {
                  const name = createName.trim();
                  if (!name) throw new Error('name is required');
                  if (createPin.length < 4)
                    throw new Error('PIN must be 4-6 digits');
                  await window.api.auth.createUser({
                    displayName: name,
                    role: createRole,
                    pin: createPin,
                    active: createActive,
                  } as any);
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
          {staffStatus && (
            <div className="text-xs opacity-80 mt-2">{staffStatus}</div>
          )}
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
                  <td className="py-1 pr-2">
                    {openUserIds.has(u.id) ? 'Yes' : 'No'}
                  </td>
                  <td className="py-1 pr-2 opacity-80">
                    {u.createdAt
                      ? new Date(u.createdAt).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="py-1 pr-2">
                    <div className="flex items-center gap-2">
                      {u.active ? (
                        <button
                          className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-40"
                          disabled={myId === u.id}
                          title={
                            myId === u.id
                              ? 'You cannot disable your own account'
                              : 'Disable user'
                          }
                          onClick={async () => {
                            setStaffStatus(null);
                            try {
                              await window.api.auth.updateUser({
                                id: u.id,
                                active: false,
                              } as any);
                              await refreshUsers();
                            } catch (e: any) {
                              setStaffStatus(
                                e?.message || 'Failed to disable user',
                              );
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
                              await window.api.auth.updateUser({
                                id: u.id,
                                active: true,
                              } as any);
                              await refreshUsers();
                            } catch (e: any) {
                              setStaffStatus(
                                e?.message || 'Failed to enable user',
                              );
                            }
                          }}
                        >
                          Enable
                        </button>
                      )}

                      <button
                        className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-xs disabled:opacity-40"
                        disabled={myId === u.id}
                        title={
                          myId === u.id
                            ? 'You cannot delete your own account'
                            : 'Permanently delete user (only if no history)'
                        }
                        onClick={async () => {
                          if (myId === u.id) return;
                          const ok = window.confirm(
                            `Permanently delete "${u.displayName}" (ID ${u.id})? This only works if they have no history.`,
                          );
                          if (!ok) return;
                          setStaffStatus(null);
                          try {
                            await window.api.auth.deleteUser({
                              id: u.id,
                              hard: true,
                            } as any);
                            setStaffStatus('Deleted.');
                            await refreshUsers();
                          } catch (e: any) {
                            setStaffStatus(
                              e?.message || 'Failed to delete user',
                            );
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

function formatMoney(amount: number, currency: string): string {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'EUR',
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency || 'EUR'}`;
  }
}

function Stat({
  title,
  value,
  kind = 'count',
  currency,
}: {
  title: string;
  value: any;
  kind?: 'count' | 'money' | 'text';
  currency?: string;
}) {
  const display =
    kind === 'money'
      ? value == null
        ? '—'
        : formatMoney(Number(value || 0), String(currency || 'EUR'))
      : value ?? '—';
  return (
    <div className="bg-gray-800 rounded p-4">
      <div className="text-sm opacity-70">{title}</div>
      <div
        className={`mt-1 ${
          kind === 'money'
            ? 'text-3xl font-bold tabular-nums tracking-tight text-emerald-100'
            : 'text-2xl font-semibold'
        }`}
      >
        {display}
      </div>
    </div>
  );
}
