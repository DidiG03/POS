import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../../stores/adminSession';
import { IconClose } from '../../components/icons';

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
  fiscalEnabled?: boolean;
  coversToday?: number;
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

function IconPencil() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M12 20h9"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      aria-hidden
    >
      <path
        d="M3 6h18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M8 6V4h8v2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 6l1 16h10l1-16"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M10 11v6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M14 11v6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconKebab() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="pos-icon"
      aria-hidden
    >
      <circle cx="12" cy="5" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="12" cy="19" r="1.75" />
    </svg>
  );
}

export default function AdminPage() {
  const { t } = useTranslation();
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
  const [showStaffMenu, setShowStaffMenu] = useState(false);
  const [showAddStaffModal, setShowAddStaffModal] = useState(false);
  const [editingStaff, setEditingStaff] = useState<{
    id: number;
    displayName: string;
    role: string;
    active: boolean;
  } | null>(null);
  const [staffStatus, setStaffStatus] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  // Auto-clear status banner after a few seconds.
  useEffect(() => {
    if (!staffStatus) return;
    const t = window.setTimeout(() => setStaffStatus(null), 4000);
    return () => window.clearTimeout(t);
  }, [staffStatus]);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [billingPaused, setBillingPaused] = useState(false);
  const me = useAdminSessionStore((s) => s.user);
  // Simplified view: hide sales trends entirely

  const myId = me?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    const safeSet = <T,>(setter: (v: T) => void, value: T) => {
      if (!cancelled) setter(value);
    };
    (async () => {
      safeSet(setAdminNotice, null);
      try {
        const s = await window.api.settings.get().catch(() => null as any);
        if (cancelled) return;
        const cur = String((s as any)?.currency || '').trim();
        if (cur) safeSet(setCurrency, cur);
      } catch {
        // ignore
      }

      // Run independent IPC calls in parallel; previously they ran sequentially.
      const [ovRes, shRes, topRes, usersRes, billingRes] =
        await Promise.allSettled([
          window.api.admin.getOverview(),
          window.api.admin.listShifts(),
          window.api.admin.getTopSellingToday(),
          window.api.auth.listUsers(),
          (window.api as any).billing?.getStatus?.() ?? Promise.resolve(null),
        ]);
      if (cancelled) return;

      if (ovRes.status === 'fulfilled') safeSet(setOv, ovRes.value);
      else {
        safeSet(
          setAdminNotice,
          (ovRes.reason as any)?.message || t('adminOverview.loadFailed'),
        );
        safeSet(setOv, null as any);
      }
      safeSet(setShifts, shRes.status === 'fulfilled' ? shRes.value : []);
      safeSet(
        setTopSelling,
        topRes.status === 'fulfilled' ? topRes.value : (null as any),
      );
      safeSet(setUsers, usersRes.status === 'fulfilled' ? usersRes.value : []);

      if (billingRes.status === 'fulfilled' && billingRes.value) {
        const b = billingRes.value as any;
        const enabled = Boolean(b?.billingEnabled);
        const st = String(b?.status || 'ACTIVE').toUpperCase();
        safeSet(
          setBillingPaused,
          enabled && (st === 'PAST_DUE' || st === 'PAUSED'),
        );
      } else {
        safeSet(setBillingPaused, false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me?.id, me?.role, t]);

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

  const staffTotals = useMemo(
    () => ({
      active: users.filter((u) => u.active).length,
      onShift: openUserIds.size,
    }),
    [openUserIds.size, users],
  );

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
  const openShifts = useMemo(
    () =>
      shifts
        .filter((s) => s.isOpen)
        .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt))),
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
    <div className="space-y-4">
      {adminNotice && (
        <div className="bg-amber-900/30 border border-amber-700 text-amber-200 rounded-lg p-3 text-sm">
          {adminNotice}
        </div>
      )}

      <section className="pos-card">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">
              {t('adminOverview.todaySnapshot')}
            </h2>
          </div>
        </div>
        <div className="grid gap-3 grid-cols-1 min-[520px]:grid-cols-2 xl:grid-cols-5 min-w-0 [&>*]:min-w-0">
          <Stat
            title={t('adminOverview.revenueTodayNet')}
            value={ov ? (ov.revenueTodayNet ?? 0) : null}
            kind="money"
            currency={currency}
          />
          <Stat
            title={t('adminOverview.vatToday')}
            value={ov ? (ov.revenueTodayVat ?? 0) : null}
            kind="money"
            currency={currency}
          />
          <Stat
            title={t('adminOverview.coversToday')}
            value={ov?.coversToday ?? 0}
          />
          <Stat title={t('adminOverview.openOrders')} value={ov?.openOrders} />
          <div className="pos-stat">
            <div className="text-sm opacity-70">
              {t('adminOverview.topSellingToday')}
            </div>
            <div className="mt-1 text-base sm:text-lg font-semibold break-words">
              {topSelling ? topSelling.name : '—'}
            </div>
            {topSelling && (
              <div className="text-sm opacity-80 mt-1 break-words">
                {t('adminOverview.qty')}: {topSelling.qty} •{' '}
                {t('adminOverview.revenue')}:{' '}
                <span className="font-semibold tabular-nums">
                  {formatMoney(topSelling.revenue, currency)}
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="pos-card">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {t('adminOverview.operations')}
            </h2>
            <p className="text-xs text-gray-400">
              {t('adminOverview.operationsHelp')}
            </p>
          </div>
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
            {t('adminOverview.viewAll')}
          </button>
        </div>
        <div className="space-y-2">
          {openShifts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-700 bg-gray-900/40 px-3 py-4 text-sm text-gray-400">
              {t('adminOverview.noOpenShifts')}
            </div>
          ) : (
            openShifts.slice(0, 4).map((s) => (
              <div
                key={s.id}
                className="rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{s.userName}</div>
                    <div className="text-xs text-gray-400">
                      {new Date(s.openedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono tabular-nums text-sm font-semibold">
                      {Number.isFinite(s.durationHours)
                        ? s.durationHours.toFixed(2)
                        : '—'}
                    </div>
                    <div className="text-[11px] uppercase tracking-wide text-gray-500">
                      {t('adminOverview.hours')}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {showShiftsModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-[92vw] max-w-5xl p-4">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <div className="text-lg font-semibold">
                  {t('adminOverview.shiftHistory')}
                </div>
                <div className="text-xs opacity-70">
                  {t('adminOverview.shiftTotals', {
                    total: shifts.length,
                    open: openShiftCount,
                    closed: closedShiftCount,
                  })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                  onClick={refreshShifts}
                  type="button"
                >
                  {t('adminOverview.refresh')}
                </button>
                <button
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                  onClick={() => setShowShiftsModal(false)}
                  type="button"
                >
                  <IconClose />
                  {t('common.close')}
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
                  {t('adminOverview.shifts')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftView === 'STAFF' ? 'bg-blue-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftView('STAFF')}
                  type="button"
                >
                  {t('adminOverview.byStaff')}
                </button>
                <div className="w-px h-7 bg-gray-700 mx-1 hidden md:block" />
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'TODAY' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('TODAY')}
                  type="button"
                >
                  {t('adminOverview.today')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'YESTERDAY' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('YESTERDAY')}
                  type="button"
                >
                  {t('adminOverview.yesterday')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'WEEK' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('WEEK')}
                  type="button"
                >
                  {t('adminOverview.week')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'MONTH' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('MONTH')}
                  type="button"
                >
                  {t('adminOverview.month')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftRange === 'ALL' ? 'bg-indigo-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftRange('ALL')}
                  type="button"
                >
                  {t('adminOverview.allTime')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftFilter === 'OPEN' ? 'bg-emerald-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftFilter('OPEN')}
                  type="button"
                >
                  {t('adminOverview.open')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftFilter === 'CLOSED' ? 'bg-emerald-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftFilter('CLOSED')}
                  type="button"
                >
                  {t('adminOverview.closed')}
                </button>
                <button
                  className={`px-3 py-1.5 rounded text-sm ${shiftFilter === 'ALL' ? 'bg-emerald-700' : 'bg-gray-800 hover:bg-gray-700'}`}
                  onClick={() => setShiftFilter('ALL')}
                  type="button"
                >
                  {t('adminOverview.all')}
                </button>
              </div>
              <div className="flex-1" />
              <input
                className="bg-gray-800 rounded px-3 py-2 text-sm w-full md:w-[320px]"
                placeholder={t('adminOverview.searchShifts')}
                value={shiftQuery}
                onChange={(e) => setShiftQuery(e.target.value)}
              />
            </div>

            {shiftView === 'SHIFTS' ? (
              <div className="overflow-auto max-h-[70vh] border border-gray-800 rounded">
                <table className="w-full text-sm">
                  <thead className="text-left bg-gray-900 sticky top-0">
                    <tr className="opacity-70">
                      <th className="py-2 px-3">
                        {t('adminOverview.colStatus')}
                      </th>
                      <th className="py-2 px-3">
                        {t('adminOverview.colStaff')}
                      </th>
                      <th className="py-2 px-3">
                        {t('adminOverview.colOpened')}
                      </th>
                      <th className="py-2 px-3">
                        {t('adminOverview.colClosed')}
                      </th>
                      <th className="py-2 px-3 text-right">
                        {t('adminOverview.colHours')}
                      </th>
                      <th className="py-2 px-3 text-right">
                        {t('adminOverview.colShiftId')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredShifts.length === 0 && (
                      <tr className="border-t border-gray-800">
                        <td className="py-3 px-3 opacity-70" colSpan={6}>
                          {t('adminOverview.noShiftsFound')}
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
                            {s.isOpen
                              ? t('adminOverview.shiftOpen')
                              : t('adminOverview.shiftClosed')}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <div className="font-medium">{s.userName}</div>
                          <div className="text-xs opacity-70">
                            {t('adminOverview.userNumber', { id: s.userId })}
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
                      <th className="py-2 px-3">
                        {t('adminOverview.colStaff')}
                      </th>
                      <th className="py-2 px-3 text-right">
                        {t('adminOverview.open')}
                      </th>
                      <th className="py-2 px-3 text-right">
                        {t('adminOverview.closed')}
                      </th>
                      <th className="py-2 px-3">
                        {t('adminOverview.colLastOpened')}
                      </th>
                      <th className="py-2 px-3">
                        {t('adminOverview.colLastClosed')}
                      </th>
                      <th className="py-2 px-3 text-right">
                        {t('adminOverview.colTotalHours')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffShiftSummary.length === 0 && (
                      <tr className="border-t border-gray-800">
                        <td className="py-3 px-3 opacity-70" colSpan={6}>
                          {t('adminOverview.noShiftsFound')}
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
                              {t('adminOverview.userNumber', { id: r.userId })}
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
                  {t('adminOverview.staffRowTip')}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <section className="pos-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {t('adminOverview.staffMembers')}
            </h2>
            <p className="text-xs text-gray-400">
              {t('adminOverview.staffHelp', {
                active: staffTotals.active,
                onShift: staffTotals.onShift,
              })}
            </p>
          </div>
          <div
            className="relative shrink-0"
            tabIndex={-1}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setShowStaffMenu(false);
              }
            }}
          >
            <button
              type="button"
              className="pos-icon-btn cursor-pointer relative"
              aria-label={t('adminOverview.staffMenu')}
              aria-haspopup="menu"
              aria-expanded={showStaffMenu}
              onClick={() => setShowStaffMenu((v) => !v)}
            >
              <IconKebab />
              {showAdmins || showInactive ? (
                <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
              ) : null}
            </button>
            {showStaffMenu ? (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-56 rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-lg z-50"
              >
                <label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-800 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showAdmins}
                    onChange={(e) => setShowAdmins(e.target.checked)}
                  />
                  {t('adminOverview.showAdmins')}
                </label>
                <label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-800 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showInactive}
                    onChange={(e) => setShowInactive(e.target.checked)}
                  />
                  {t('adminOverview.showInactive')}
                </label>
                <div className="my-1 border-t border-gray-700" />
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-800 disabled:opacity-60 cursor-pointer"
                  disabled={billingPaused}
                  onClick={() => {
                    setShowStaffMenu(false);
                    setShowAddStaffModal(true);
                  }}
                >
                  {t('adminOverview.addStaff')}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {showAddStaffModal && (
          <AddStaffModal
            billingPaused={billingPaused}
            onClose={() => setShowAddStaffModal(false)}
            onSuccess={async () => {
              await refreshUsers();
              setShowAddStaffModal(false);
            }}
          />
        )}

        {editingStaff && (
          <EditStaffModal
            staff={editingStaff}
            isSelf={myId === editingStaff.id}
            onClose={() => setEditingStaff(null)}
            onSaved={async (msg) => {
              setStaffStatus({ kind: 'success', message: msg });
              await refreshUsers();
              setEditingStaff(null);
            }}
            onError={(msg) => setStaffStatus({ kind: 'error', message: msg })}
          />
        )}

        {staffStatus && (
          <div
            role="status"
            className={`mb-3 text-sm rounded px-3 py-2 border ${
              staffStatus.kind === 'success'
                ? 'bg-emerald-900/20 border-emerald-800 text-emerald-100'
                : 'bg-rose-900/20 border-rose-800 text-rose-100'
            }`}
          >
            {staffStatus.message}
          </div>
        )}

        <div className="mt-4 mb-3">
          <input
            className="w-full bg-gray-900/70 border border-gray-700 rounded-lg px-3 py-2"
            placeholder={t('adminOverview.searchStaff')}
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
          {staffList.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-700 bg-gray-900/40 px-3 py-4 text-sm text-gray-400">
              {t('adminOverview.noStaffFound')}
            </div>
          ) : (
            staffList.map((u) => (
              <div
                key={u.id}
                className="rounded-lg border border-gray-700 bg-gray-900/50 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="truncate text-base font-semibold">
                        {u.displayName}
                      </div>
                      {!u.active ? (
                        <span className="rounded-full border border-rose-700 bg-rose-900/30 px-2 py-0.5 text-[10px] uppercase tracking-wide text-rose-100">
                          {t('adminOverview.showInactive')}
                        </span>
                      ) : openUserIds.has(u.id) ? (
                        <span className="rounded-full border border-emerald-700 bg-emerald-900/30 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-100">
                          {t('adminOverview.colOnShift')}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                      <span className="rounded bg-gray-950/80 px-2 py-0.5 font-mono">
                        #{u.id}
                      </span>
                      <span className="rounded border border-gray-700 bg-gray-950/60 px-2 py-0.5">
                        {u.role}
                      </span>
                      <span>
                        {t('adminOverview.colCreated')}:{' '}
                        {u.createdAt
                          ? new Date(u.createdAt).toLocaleDateString()
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    className="px-2.5 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs cursor-pointer border border-gray-700"
                    title={t('adminOverview.editStaffTitle')}
                    onClick={() =>
                      setEditingStaff({
                        id: u.id,
                        displayName: u.displayName,
                        role: u.role,
                        active: Boolean(u.active),
                      })
                    }
                  >
                    <IconPencil />
                  </button>
                  {u.active ? (
                    <button
                      className="px-2.5 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs disabled:opacity-40 border border-gray-700"
                      disabled={myId === u.id}
                      title={
                        myId === u.id
                          ? t('adminOverview.disableSelfTitle')
                          : t('adminOverview.disableUserTitle')
                      }
                      onClick={async () => {
                        setStaffStatus(null);
                        try {
                          await window.api.auth.updateUser({
                            id: u.id,
                            active: false,
                          } as any);
                          setStaffStatus({
                            kind: 'success',
                            message: t('adminOverview.disabledUser', {
                              name: u.displayName,
                            }),
                          });
                          await refreshUsers();
                        } catch (e: any) {
                          setStaffStatus({
                            kind: 'error',
                            message:
                              e?.message || t('adminOverview.disableFailed'),
                          });
                        }
                      }}
                    >
                      {t('adminOverview.disable')}
                    </button>
                  ) : (
                    <button
                      className="px-2.5 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 text-xs"
                      onClick={async () => {
                        setStaffStatus(null);
                        try {
                          await window.api.auth.updateUser({
                            id: u.id,
                            active: true,
                          } as any);
                          setStaffStatus({
                            kind: 'success',
                            message: t('adminOverview.enabledUser', {
                              name: u.displayName,
                            }),
                          });
                          await refreshUsers();
                        } catch (e: any) {
                          setStaffStatus({
                            kind: 'error',
                            message:
                              e?.message || t('adminOverview.enableFailed'),
                          });
                        }
                      }}
                    >
                      {t('adminOverview.enable')}
                    </button>
                  )}

                  <button
                    className="ml-auto px-2.5 py-1.5 rounded bg-red-800 hover:bg-red-700 text-xs disabled:opacity-40"
                    disabled={myId === u.id}
                    title={
                      myId === u.id
                        ? t('adminOverview.deleteSelfTitle')
                        : t('adminOverview.deleteUserTitle')
                    }
                    onClick={async () => {
                      if (myId === u.id) return;
                      const ok = window.confirm(
                        t('adminOverview.deleteConfirm', {
                          name: u.displayName,
                          id: u.id,
                        }),
                      );
                      if (!ok) return;
                      setStaffStatus(null);
                      try {
                        await window.api.auth.deleteUser({
                          id: u.id,
                          hard: true,
                        } as any);
                        setStaffStatus({
                          kind: 'success',
                          message: t('adminOverview.deletedUser', {
                            name: u.displayName,
                          }),
                        });
                        await refreshUsers();
                      } catch (e: any) {
                        setStaffStatus({
                          kind: 'error',
                          message:
                            e?.message || t('adminOverview.deleteFailed'),
                        });
                      }
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
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
      : (value ?? '—');
  return (
    <div className="pos-stat">
      <div className="text-sm opacity-70 leading-snug">{title}</div>
      <div
        className={`mt-1 min-w-0 ${
          kind === 'money'
            ? 'pos-stat-value text-lg sm:text-xl md:text-2xl lg:text-3xl leading-tight break-words'
            : 'text-xl sm:text-2xl font-semibold tabular-nums break-words'
        }`}
      >
        {display}
      </div>
    </div>
  );
}

type StaffRole =
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
  | 'CLEANER';

function AddStaffModal({
  billingPaused,
  onClose,
  onSuccess,
}: {
  billingPaused: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('WAITER');
  const [pin, setPin] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleSubmit() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('adminOverview.nameRequired'));
      return;
    }
    if (pin.length < 4) {
      setError(t('adminOverview.pinRequired'));
      return;
    }
    setSaving(true);
    try {
      await window.api.auth.createUser({
        displayName: trimmed,
        role,
        pin,
        active,
      } as any);
      await onSuccess();
    } catch (e: any) {
      setError(e?.message || t('adminOverview.createUserFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label={t('common.close')}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between gap-3">
          <div className="font-semibold">{t('adminOverview.addStaff')}</div>
          <button
            type="button"
            className="w-9 h-9 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="pos-icon"
            >
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-4">
          {billingPaused && (
            <div className="text-xs text-amber-200 bg-amber-900/20 border border-amber-800 rounded p-2">
              {t('adminOverview.billingPausedAddStaff')}
            </div>
          )}
          <label className="block text-sm">
            <div className="opacity-80 mb-1">{t('adminOverview.fullName')}</div>
            <input
              className="w-full bg-gray-700 rounded px-3 py-2"
              placeholder={t('adminOverview.fullName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={billingPaused}
            />
          </label>
          <label className="block text-sm">
            <div className="opacity-80 mb-1">{t('adminOverview.role')}</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={role}
              onChange={(e) => setRole(e.target.value as StaffRole)}
              disabled={billingPaused}
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
          </label>
          <label className="block text-sm">
            <div className="opacity-80 mb-1">
              {t('adminOverview.pinDigits')}
            </div>
            <input
              className="w-full bg-gray-700 rounded px-3 py-2"
              placeholder={t('adminOverview.pinDigits')}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) =>
                setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              }
              disabled={billingPaused}
            />
          </label>
          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={billingPaused}
            />
            {t('adminOverview.active')}
          </label>
          {error && <div className="text-sm text-rose-300">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button
              className="flex-1 px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60"
              type="button"
              disabled={billingPaused || saving}
              onClick={() => void handleSubmit()}
            >
              {saving ? t('adminOverview.adding') : t('adminOverview.add')}
            </button>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
              type="button"
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EditStaffModal({
  staff,
  isSelf,
  onClose,
  onSaved,
  onError,
}: {
  staff: { id: number; displayName: string; role: string; active: boolean };
  isSelf: boolean;
  onClose: () => void;
  onSaved: (message: string) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(staff.displayName);
  const [role, setRole] = useState<StaffRole>(staff.role as StaffRole);
  const [pin, setPin] = useState('');
  const [active, setActive] = useState(staff.active);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Only send fields that actually changed (or PIN if user typed one).
  const dirty =
    name.trim() !== staff.displayName ||
    role !== staff.role ||
    active !== staff.active ||
    pin.length > 0;

  async function handleSubmit() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('adminOverview.nameRequired'));
      return;
    }
    if (pin && pin.length < 4) {
      setError(t('adminOverview.pinKeepOrBlank'));
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { id: staff.id };
      if (trimmed !== staff.displayName) payload.displayName = trimmed;
      if (role !== staff.role) payload.role = role;
      if (active !== staff.active) payload.active = active;
      if (pin) payload.pin = pin;
      await window.api.auth.updateUser(payload as any);
      await onSaved(t('adminOverview.updatedUser', { name: trimmed }));
    } catch (e: any) {
      const msg = e?.message || t('adminOverview.updateFailed');
      setError(msg);
      onError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label={t('common.close')}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between gap-3">
          <div className="font-semibold">
            {t('adminOverview.editStaffId', { id: staff.id })}
          </div>
          <button
            type="button"
            className="w-9 h-9 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="pos-icon"
            >
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-4 space-y-4">
          <label className="block text-sm">
            <div className="opacity-80 mb-1">{t('adminOverview.fullName')}</div>
            <input
              className="w-full bg-gray-700 rounded px-3 py-2"
              placeholder={t('adminOverview.fullName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <div className="opacity-80 mb-1">{t('adminOverview.role')}</div>
            <select
              className="w-full bg-gray-700 rounded px-3 py-2"
              value={role}
              onChange={(e) => setRole(e.target.value as StaffRole)}
              disabled={isSelf && staff.role === 'ADMIN'}
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
            {isSelf && staff.role === 'ADMIN' && (
              <div className="text-xs opacity-70 mt-1">
                {t('adminOverview.cantChangeOwnRole')}
              </div>
            )}
          </label>
          <label className="block text-sm">
            <div className="opacity-80 mb-1">
              {t('adminOverview.newPin')}{' '}
              <span className="opacity-60">
                {t('adminOverview.newPinHint')}
              </span>
            </div>
            <input
              className="w-full bg-gray-700 rounded px-3 py-2"
              placeholder={t('adminOverview.pinDigitsShort')}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) =>
                setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              }
            />
          </label>
          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={isSelf}
            />
            {t('adminOverview.active')}
            {isSelf && (
              <span className="text-xs opacity-70">
                {t('adminOverview.cantDeactivateSelf')}
              </span>
            )}
          </label>
          {error && <div className="text-sm text-rose-300">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button
              className="flex-1 px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60"
              type="button"
              disabled={saving || !dirty}
              onClick={() => void handleSubmit()}
            >
              {saving ? t('common.saving') : t('adminOverview.saveChanges')}
            </button>
            <button
              className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600"
              type="button"
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
