import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../../stores/adminSession';
import { IconClose } from '../../components/icons';
import { KebabMenu } from '../components/SettingsChrome';
import { Button } from '../../components/ui/Button';
import {
  Field,
  Input,
  SearchInput,
  Select,
  Switch,
} from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/Surface';
import { Segmented } from '../../components/ui/Segmented';
import { cn } from '../../components/ui/cn';

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

const STAFF_ROLES: StaffRole[] = [
  'WAITER',
  'CASHIER',
  'ADMIN',
  'KP',
  'CHEF',
  'HEAD_CHEF',
  'FOOD_RUNNER',
  'HOST',
  'BUSSER',
  'BARTENDER',
  'BARBACK',
  'CLEANER',
];

function roleLabel(
  t: (key: string, opts?: { defaultValue?: string }) => string,
  role: string,
) {
  return t(`adminOverview.roles.${role}`, { defaultValue: role });
}

function formatShiftDuration(
  hours: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  const totalMin = Math.max(0, Math.round(hours * 60));
  const days = Math.floor(totalMin / (24 * 60));
  const hrs = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0)
    return t('adminOverview.durationDaysHours', { days, hours: hrs });
  if (hrs > 0 && mins > 0)
    return t('adminOverview.durationHoursMins', { hours: hrs, mins });
  if (hrs > 0) return t('adminOverview.durationHoursOnly', { hours: hrs });
  return t('adminOverview.durationMins', { mins });
}

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: StaffRole;
  onChange: (next: StaffRole) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value as StaffRole)}
      disabled={disabled}
    >
      {STAFF_ROLES.map((r) => (
        <option key={r} value={r}>
          {roleLabel(t, r)}
        </option>
      ))}
    </Select>
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

  const quietDay =
    !ov?.revenueTodayNet && !ov?.coversToday && !ov?.openOrders && !topSelling;

  async function setStaffActive(id: number, name: string, active: boolean) {
    setStaffStatus(null);
    try {
      await window.api.auth.updateUser({ id, active } as any);
      setStaffStatus({
        kind: 'success',
        message: active
          ? t('adminOverview.enabledUser', { name })
          : t('adminOverview.disabledUser', { name }),
      });
      await refreshUsers();
    } catch (e: any) {
      setStaffStatus({
        kind: 'error',
        message:
          e?.message ||
          (active
            ? t('adminOverview.enableFailed')
            : t('adminOverview.disableFailed')),
      });
    }
  }

  async function deleteStaff(id: number, name: string) {
    const ok = window.confirm(t('adminOverview.deleteConfirm', { name, id }));
    if (!ok) return;
    setStaffStatus(null);
    try {
      await window.api.auth.deleteUser({ id, hard: true } as any);
      setStaffStatus({
        kind: 'success',
        message: t('adminOverview.deletedUser', { name }),
      });
      await refreshUsers();
    } catch (e: any) {
      setStaffStatus({
        kind: 'error',
        message: e?.message || t('adminOverview.deleteFailed'),
      });
    }
  }

  return (
    <div className="space-y-4">
      {adminNotice ? (
        <div className="rounded-lg border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-[13px] text-amber-200">
          {adminNotice}
        </div>
      ) : null}

      <section className="rounded-lg border border-white/7 bg-[var(--pos-surface)] p-4">
        <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400">
          {t('adminOverview.todaySnapshot')}
        </h2>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 min-[520px]:grid-cols-2 xl:grid-cols-5">
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
          <Stat
            title={t('adminOverview.topSellingToday')}
            value={topSelling ? topSelling.name : '—'}
            kind="text"
            hint={
              topSelling
                ? `${t('adminOverview.qty')}: ${topSelling.qty} · ${t('adminOverview.revenue')}: ${formatMoney(topSelling.revenue, currency)}`
                : t('adminOverview.noTopSeller')
            }
          />
        </div>
        {quietDay ? (
          <p className="mt-4 text-[12px] text-gray-500">
            {t('adminOverview.emptyTodayHint')}
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-white/7 bg-[var(--pos-surface)]">
        <div className="flex items-start justify-between gap-3 border-b border-white/7 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold tracking-tight text-gray-50">
              {t('adminOverview.operations')}
            </h2>
            <p className="mt-0.5 text-[12px] text-gray-500">
              {t('adminOverview.operationsHelp')}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setShiftFilter('ALL');
              setShiftView('SHIFTS');
              setShiftRange('TODAY');
              setShowShiftsModal(true);
              void refreshShifts();
            }}
          >
            {t('adminOverview.viewAll')}
          </Button>
        </div>
        {openShifts.length === 0 ? (
          <EmptyState
            compact
            title={t('adminOverview.noOpenShifts')}
            description={t('adminOverview.noOpenShiftsHint')}
          />
        ) : (
          <div className="divide-y divide-white/6">
            {openShifts.slice(0, 4).map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-gray-100">
                    {s.userName}
                  </div>
                  <div className="mt-0.5 text-[12px] text-gray-500">
                    {t('adminOverview.sinceOpened', {
                      when: new Date(s.openedAt).toLocaleString(),
                    })}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[13px] font-semibold tabular-nums text-gray-50">
                    {formatShiftDuration(s.durationHours, t)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showShiftsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
            onClick={() => setShowShiftsModal(false)}
            aria-label={t('common.close')}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-white/10 bg-[var(--pos-surface)] shadow-2xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/7 px-4 py-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">
                  {t('adminOverview.shiftHistory')}
                </div>
                <div className="mt-0.5 text-[12px] text-gray-500">
                  {t('adminOverview.shiftTotals', {
                    total: shifts.length,
                    open: openShiftCount,
                    closed: closedShiftCount,
                  })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void refreshShifts()}>
                  {t('common.refresh')}
                </Button>
                <Button
                  size="sm"
                  icon={<IconClose />}
                  onClick={() => setShowShiftsModal(false)}
                >
                  {t('common.close')}
                </Button>
              </div>
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-b border-white/7 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  size="sm"
                  value={shiftView}
                  onChange={setShiftView}
                  options={[
                    { value: 'SHIFTS', label: t('adminOverview.shifts') },
                    { value: 'STAFF', label: t('adminOverview.byStaff') },
                  ]}
                />
                <Select
                  className="w-auto"
                  value={shiftRange}
                  onChange={(e) =>
                    setShiftRange(
                      e.target.value as
                        | 'TODAY'
                        | 'YESTERDAY'
                        | 'WEEK'
                        | 'MONTH'
                        | 'ALL',
                    )
                  }
                >
                  <option value="TODAY">{t('adminOverview.today')}</option>
                  <option value="YESTERDAY">
                    {t('adminOverview.yesterday')}
                  </option>
                  <option value="WEEK">{t('adminOverview.week')}</option>
                  <option value="MONTH">{t('adminOverview.month')}</option>
                  <option value="ALL">{t('adminOverview.allTime')}</option>
                </Select>
                {shiftView === 'SHIFTS' ? (
                  <Segmented
                    size="sm"
                    value={shiftFilter}
                    onChange={setShiftFilter}
                    options={[
                      { value: 'OPEN', label: t('adminOverview.open') },
                      { value: 'CLOSED', label: t('adminOverview.closed') },
                      { value: 'ALL', label: t('adminOverview.all') },
                    ]}
                  />
                ) : null}
                <div className="min-w-[200px] flex-1">
                  <SearchInput
                    value={shiftQuery}
                    onValueChange={setShiftQuery}
                    placeholder={t('adminOverview.searchShifts')}
                  />
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4">
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
                            <Badge tone={s.isOpen ? 'accent' : 'neutral'} dot>
                              {s.isOpen
                                ? t('adminOverview.shiftOpen')
                                : t('adminOverview.shiftClosed')}
                            </Badge>
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
                          <td className="py-2 px-3 text-right tabular-nums">
                            {formatShiftDuration(s.durationHours, t)}
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
                                {t('adminOverview.userNumber', {
                                  id: r.userId,
                                })}
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
                            <td className="py-2 px-3 text-right tabular-nums">
                              {formatShiftDuration(r.totalHours, t)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  <div className="border-t border-white/7 px-3 py-2 text-[12px] text-gray-500">
                    {t('adminOverview.staffRowTip')}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <section className="rounded-lg border border-white/7 bg-[var(--pos-surface)]">
        <div className="flex items-start justify-between gap-3 border-b border-white/7 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold tracking-tight text-gray-50">
              {t('adminOverview.staffMembers')}
            </h2>
            <p className="mt-0.5 text-[12px] text-gray-500">
              {t('adminOverview.staffHelp', {
                active: staffTotals.active,
                onShift: staffTotals.onShift,
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              disabled={billingPaused}
              onClick={() => setShowAddStaffModal(true)}
            >
              {t('adminOverview.addStaff')}
            </Button>
            <KebabMenu
              label={t('adminOverview.staffMenu')}
              items={[
                {
                  label: showAdmins
                    ? t('adminOverview.hideAdmins')
                    : t('adminOverview.showAdmins'),
                  onSelect: () => setShowAdmins((v) => !v),
                },
                {
                  label: showInactive
                    ? t('adminOverview.hideInactive')
                    : t('adminOverview.showInactive'),
                  onSelect: () => setShowInactive((v) => !v),
                },
              ]}
            />
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

        {staffStatus ? (
          <div
            role="status"
            className={cn(
              'mx-4 mt-3 rounded-lg border px-3 py-2 text-[13px]',
              staffStatus.kind === 'success'
                ? 'border-emerald-800/70 bg-emerald-900/20 text-emerald-100'
                : 'border-rose-800/70 bg-rose-900/20 text-rose-100',
            )}
          >
            {staffStatus.message}
          </div>
        ) : null}

        <div className="px-4 py-3">
          <SearchInput
            value={userQuery}
            onValueChange={setUserQuery}
            placeholder={t('adminOverview.searchStaff')}
          />
        </div>

        {staffList.length === 0 ? (
          <EmptyState
            compact
            title={t('adminOverview.noStaffFound')}
            className="pb-6"
          />
        ) : (
          <div className="grid grid-cols-1 gap-px bg-white/6 sm:grid-cols-2 2xl:grid-cols-3">
            {staffList.map((u) => {
              const onShift = openUserIds.has(u.id);
              return (
                <div
                  key={u.id}
                  className="flex items-start gap-3 bg-[var(--pos-surface)] px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-[13px] font-semibold text-gray-50">
                        {u.displayName}
                      </div>
                      {!u.active ? (
                        <Badge tone="danger">
                          {t('adminOverview.inactive')}
                        </Badge>
                      ) : onShift ? (
                        <Badge tone="accent" dot>
                          {t('adminOverview.colOnShift')}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-gray-500">
                      <span className="font-mono tabular-nums">#{u.id}</span>
                      <span aria-hidden>·</span>
                      <span>{roleLabel(t, u.role)}</span>
                    </div>
                  </div>
                  <KebabMenu
                    label={t('common.moreActions')}
                    items={[
                      {
                        label: t('common.edit'),
                        onSelect: () =>
                          setEditingStaff({
                            id: u.id,
                            displayName: u.displayName,
                            role: u.role,
                            active: Boolean(u.active),
                          }),
                      },
                      {
                        label: u.active
                          ? t('adminOverview.disable')
                          : t('adminOverview.enable'),
                        disabled: myId === u.id,
                        onSelect: () =>
                          void setStaffActive(u.id, u.displayName, !u.active),
                      },
                      {
                        label: t('common.delete'),
                        danger: true,
                        disabled: myId === u.id,
                        onSelect: () => void deleteStaff(u.id, u.displayName),
                      },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
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
  hint,
}: {
  title: string;
  value: any;
  kind?: 'count' | 'money' | 'text';
  currency?: string;
  hint?: string;
}) {
  const display =
    kind === 'money'
      ? value == null
        ? '—'
        : formatMoney(Number(value || 0), String(currency || 'EUR'))
      : kind === 'text'
        ? (value ?? '—')
        : value == null
          ? '—'
          : String(value);
  const quiet =
    display === '—' ||
    display === '0' ||
    /([^\d]|^)0([.,]00)?$/.test(String(display));
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium leading-snug text-gray-400">
        {title}
      </div>
      <div
        className={cn(
          'mt-1.5 min-w-0 break-words text-[22px] font-semibold tracking-tight tabular-nums',
          quiet ? 'text-gray-500' : 'text-gray-50',
        )}
      >
        {display}
      </div>
      {hint ? (
        <div className="mt-1 text-[11px] text-gray-500">{hint}</div>
      ) : null}
    </div>
  );
}

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
        className="relative w-full max-w-md overflow-hidden rounded-lg border border-white/10 bg-[var(--pos-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/7 px-4 py-3">
          <div className="text-[15px] font-semibold">
            {t('adminOverview.addStaff')}
          </div>
          <Button size="sm" icon={<IconClose />} onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
        <div className="space-y-4 p-4">
          {billingPaused ? (
            <div className="rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-[12px] text-amber-200">
              {t('adminOverview.billingPausedAddStaff')}
            </div>
          ) : null}
          <Field label={t('adminOverview.fullName')}>
            <Input
              placeholder={t('adminOverview.fullName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={billingPaused}
            />
          </Field>
          <Field label={t('adminOverview.role')}>
            <RoleSelect
              value={role}
              onChange={setRole}
              disabled={billingPaused}
            />
          </Field>
          <Field label={t('adminOverview.pinDigits')}>
            <Input
              placeholder={t('adminOverview.pinDigits')}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) =>
                setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              }
              disabled={billingPaused}
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px]">{t('adminOverview.active')}</span>
            <Switch
              checked={active}
              onChange={setActive}
              disabled={billingPaused}
              label={t('adminOverview.active')}
            />
          </div>
          {error ? (
            <div className="text-[13px] text-rose-300">{error}</div>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              className="flex-1"
              disabled={billingPaused || saving}
              loading={saving}
              onClick={() => void handleSubmit()}
            >
              {saving ? t('adminOverview.adding') : t('adminOverview.add')}
            </Button>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
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
        className="relative w-full max-w-md overflow-hidden rounded-lg border border-white/10 bg-[var(--pos-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/7 px-4 py-3">
          <div className="text-[15px] font-semibold">
            {t('adminOverview.editStaffId', { id: staff.id })}
          </div>
          <Button size="sm" icon={<IconClose />} onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
        <div className="space-y-4 p-4">
          <Field label={t('adminOverview.fullName')}>
            <Input
              placeholder={t('adminOverview.fullName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={t('adminOverview.role')}
            hint={
              isSelf && staff.role === 'ADMIN'
                ? t('adminOverview.cantChangeOwnRole')
                : undefined
            }
          >
            <RoleSelect
              value={role}
              onChange={setRole}
              disabled={isSelf && staff.role === 'ADMIN'}
            />
          </Field>
          <Field
            label={t('adminOverview.newPin')}
            hint={t('adminOverview.newPinHint')}
          >
            <Input
              placeholder={t('adminOverview.pinDigitsShort')}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) =>
                setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))
              }
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px]">{t('adminOverview.active')}</div>
              {isSelf ? (
                <div className="text-[12px] text-gray-500">
                  {t('adminOverview.cantDeactivateSelf')}
                </div>
              ) : null}
            </div>
            <Switch
              checked={active}
              onChange={setActive}
              disabled={isSelf}
              label={t('adminOverview.active')}
            />
          </div>
          {error ? (
            <div className="text-[13px] text-rose-300">{error}</div>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              className="flex-1"
              disabled={saving || !dirty}
              loading={saving}
              onClick={() => void handleSubmit()}
            >
              {saving ? t('common.saving') : t('adminOverview.saveChanges')}
            </Button>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
