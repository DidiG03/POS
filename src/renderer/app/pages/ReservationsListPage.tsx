import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReservationsContext } from '../ReservationsLayout';
import type { ReservationDTO, ReservationStatus } from '@shared/ipc';
import { reservationStatusLabel } from '../../utils/reservationLabels';
import { effectiveReservationStatus } from '@shared/reservationDuration';
import {
  isReservationQuickStatusTooEarly,
  reservationQuickStatusUnlockHint,
} from '../../utils/reservationStatusWindow';
import { PageSpinner } from '../../components/PageSpinner';
import { afterPaint } from '../../utils/afterPaint';

const STATUS_BADGE: Record<ReservationStatus, string> = {
  BOOKED: 'bg-amber-900/60 border-amber-700 text-amber-100',
  SEATED: 'bg-rose-900/60 border-rose-700 text-rose-100',
  COMPLETED: 'bg-zinc-700/60 border-zinc-500 text-zinc-200',
  CANCELLED: 'bg-gray-700/60 border-gray-600 text-gray-200',
  NO_SHOW: 'bg-gray-700/60 border-gray-600 text-gray-300 line-through',
};

function StatusChip({ status }: { status: ReservationStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${STATUS_BADGE[status]}`}
    >
      {reservationStatusLabel(t, status)}
    </span>
  );
}

const ALL_STATUSES: ReservationStatus[] = [
  'BOOKED',
  'SEATED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
];

function listQuickStatuses(status: ReservationStatus): ReservationStatus[] {
  if (status === 'SEATED') return ['COMPLETED', 'NO_SHOW', 'CANCELLED'];
  if (status === 'BOOKED') return ['SEATED', 'NO_SHOW', 'CANCELLED'];
  return [];
}

function quickButtonClass(s: ReservationStatus): string {
  switch (s) {
    case 'SEATED':
      return 'bg-rose-700 hover:bg-rose-600';
    case 'COMPLETED':
      return 'bg-zinc-600 hover:bg-zinc-500';
    case 'NO_SHOW':
      return 'bg-gray-600 hover:bg-gray-500';
    case 'CANCELLED':
      return 'bg-zinc-700 hover:bg-zinc-600';
    default:
      return 'bg-gray-700 hover:bg-gray-600';
  }
}

function cleanIpcMessage(e: any, fallback: string): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return fallback;
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || fallback;
}

// Diacritic-insensitive, case-insensitive normaliser used by the search box.
function norm(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Strip everything that's not a digit so phone search matches across formats
// like "+355 69 123 4567", "069 123 4567", "0691234567".
function digits(s: string | null | undefined): string {
  return String(s || '').replace(/\D+/g, '');
}

function isLiveListStatus(status: ReservationStatus): boolean {
  return status === 'BOOKED' || status === 'SEATED';
}

export default function ReservationsListPage() {
  const { t } = useTranslation();
  const ctx = useOutletContext<ReservationsContext>();
  const {
    date,
    areas,
    me,
    openEditor,
    notifyReservationsChanged,
    listFiltersOpen,
    setListFiltersOpen,
    setListFiltersActive,
  } = ctx;
  const [reservations, setReservations] = useState<ReservationDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resReadyKey, setResReadyKey] = useState<string | null>(null);
  const [viewReadyKey, setViewReadyKey] = useState<string | null>(null);

  // Filters
  const [query, setQuery] = useState('');
  const [areaFilter, setAreaFilter] = useState<string>(''); // '' = all
  // Single-select status filter — '' means "any". A dropdown keeps the
  // toolbar compact enough to fit on one line on tablets.
  const [statusFilter, setStatusFilter] = useState<ReservationStatus | ''>('');
  // Finished (COMPLETED / CANCELLED / NO_SHOW) stay off the list unless
  // the host turns them on here.
  const [showFinished, setShowFinished] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [actionRow, setActionRow] = useState<ReservationDTO | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function clearFilters() {
    setQuery('');
    setAreaFilter('');
    setStatusFilter('');
    setShowFinished(false);
  }

  const reloadGen = useRef(0);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      const gen = ++reloadGen.current;
      const myKey = date.toISOString();
      setError(null);
      try {
        const list = await window.api.reservations.list({
          dateIso: date.toISOString(),
        });
        if (gen !== reloadGen.current) return;
        setReservations(list);
        setResReadyKey(myKey);
      } catch (e: any) {
        if (gen !== reloadGen.current) return;
        setError(e?.message || t('reservations.loadFailed'));
        if (!opts?.silent) setResReadyKey(myKey);
      }
    },
    [date, t],
  );

  function onRowPress(r: ReservationDTO) {
    const status = effectiveReservationStatus(r, nowMs) as ReservationStatus;
    if (listQuickStatuses(status).length === 0) {
      openEditor(r);
      return;
    }
    setActionError(null);
    setActionBusy(false);
    setActionRow(r);
  }

  async function applyListStatus(r: ReservationDTO, status: ReservationStatus) {
    if (!me?.id) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const updated = await window.api.reservations.setStatus({
        id: r.id,
        actorId: me.id,
        status,
      });
      notifyReservationsChanged(
        'status',
        updated?.startsAt || r.startsAt,
        updated?.area || r.area,
      );
      setActionRow(null);
      await reload({ silent: true });
    } catch (e) {
      setActionError(cleanIpcMessage(e, t('reservations.somethingWrong')));
    } finally {
      setActionBusy(false);
    }
  }

  useEffect(() => {
    void reload({ silent: false });
  }, [reload]);

  // Live updates: refetch when any client mutates a reservation. We always
  // refetch the whole day so turning on "show finished" does not need a
  // second fetch. The list is page-sized so this remains snappy.
  useEffect(() => {
    const onChanged = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as { dateIso?: string };
        if (detail.dateIso) {
          const a = new Date(detail.dateIso);
          const same =
            a.getFullYear() === date.getFullYear() &&
            a.getMonth() === date.getMonth() &&
            a.getDate() === date.getDate();
          if (!same) return;
        }
        void reload({ silent: true });
      } catch {
        void reload({ silent: true });
      }
    };
    // Foreground refresh: if SSE missed updates while the tablet was asleep
    // (Android background kill, iOS bfcache), refetch the visible day as
    // soon as the user returns to the panel.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload({ silent: true });
    };
    window.addEventListener('pos:reservationsChanged', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.removeEventListener('pos:reservationsChanged', onChanged);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [reload, date]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const sorted = useMemo(
    () =>
      [...reservations].sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      ),
    [reservations],
  );

  const filtered = useMemo(() => {
    const qText = norm(query.trim());
    const qDigits = digits(query);
    const useText = qText.length > 0;
    const usePhone = qDigits.length >= 2;
    const useStatus = statusFilter !== '';
    const useArea = areaFilter.length > 0;
    return sorted.filter((r) => {
      const status = effectiveReservationStatus(r, nowMs) as ReservationStatus;
      if (useStatus) {
        if (status !== statusFilter) return false;
      } else if (!showFinished && !isLiveListStatus(status)) {
        return false;
      }
      if (useArea && r.area !== areaFilter) return false;
      if (useText || usePhone) {
        const nameHit = useText && norm(r.customerName).includes(qText);
        const noteHit = useText && norm(r.note).includes(qText);
        const tableHit = useText && norm(r.tableLabel).includes(qText);
        const phoneHit = usePhone && digits(r.customerPhone).includes(qDigits);
        if (!nameHit && !noteHit && !tableHit && !phoneHit) return false;
      }
      return true;
    });
  }, [sorted, query, statusFilter, areaFilter, showFinished, nowMs]);

  const totalCovers = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.partySize || 0), 0),
    [filtered],
  );

  const filtersActive =
    query.length > 0 ||
    areaFilter.length > 0 ||
    statusFilter !== '' ||
    showFinished;

  const coversLabel = t('reservations.covers', { count: totalCovers });

  const universeCount = useMemo(() => {
    if (showFinished || statusFilter !== '') return sorted.length;
    return sorted.filter((r) =>
      isLiveListStatus(effectiveReservationStatus(r, nowMs)),
    ).length;
  }, [sorted, showFinished, statusFilter, nowMs]);

  const emptyListMessage =
    sorted.length === 0
      ? t('reservations.noReservationsDay')
      : !filtersActive
        ? t('reservations.noLiveReservations')
        : t('reservations.noMatchFilters');

  const snapshotKey = date.toISOString();
  const contentReady = resReadyKey === snapshotKey;
  const viewReady = viewReadyKey === snapshotKey;

  useEffect(() => {
    if (!contentReady) return;
    return afterPaint(() => setViewReadyKey(snapshotKey));
  }, [contentReady, snapshotKey, reservations]);

  useEffect(() => {
    setListFiltersActive(filtersActive);
  }, [filtersActive, setListFiltersActive]);

  useEffect(() => {
    return () => setListFiltersActive(false);
  }, [setListFiltersActive]);

  const summaryText = !viewReady
    ? t('reservations.loadingReservations')
    : filtersActive
      ? t('reservations.summaryFiltered', {
          filtered: filtered.length,
          total: universeCount,
          covers: coversLabel,
        })
      : t('reservations.summaryTotal', {
          count: filtered.length,
          covers: coversLabel,
        });

  const actionShown = actionRow
    ? (effectiveReservationStatus(actionRow, nowMs) as ReservationStatus)
    : null;
  const actionWhen = actionRow ? new Date(actionRow.startsAt) : null;
  const actionHh = actionWhen
    ? String(actionWhen.getHours()).padStart(2, '0')
    : '';
  const actionMm = actionWhen
    ? String(actionWhen.getMinutes()).padStart(2, '0')
    : '';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm opacity-80">{summaryText}</div>
      </div>

      {listFiltersOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 sm:p-4"
          onClick={() => setListFiltersOpen(false)}
        >
          <div
            className="w-full sm:max-w-md bg-gray-800 border border-gray-700 sm:rounded-lg rounded-t-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="text-lg font-semibold">
                {t('reservations.filters')}
              </div>
              <button
                type="button"
                className="px-3 py-2 rounded hover:bg-gray-700 text-lg leading-none"
                onClick={() => setListFiltersOpen(false)}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="relative">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('reservations.searchPlaceholder')}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 pr-8 text-base"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 px-1.5 rounded hover:bg-gray-700 text-xs opacity-70"
                    title={t('reservations.clearSearch')}
                  >
                    ✕
                  </button>
                )}
              </div>
              <label className="block">
                <div className="text-xs opacity-70 mb-1">
                  {t('reservations.filterByArea')}
                </div>
                <select
                  value={areaFilter}
                  onChange={(e) => setAreaFilter(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
                  title={t('reservations.filterByArea')}
                >
                  <option value="">{t('reservations.allAreas')}</option>
                  {areas.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <div className="text-xs opacity-70 mb-1">
                  {t('reservations.filterByStatus')}
                </div>
                <select
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as ReservationStatus | '')
                  }
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
                  title={t('reservations.filterByStatus')}
                >
                  <option value="">{t('reservations.anyStatus')}</option>
                  {ALL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {reservationStatusLabel(t, s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showFinished}
                  onChange={(e) => setShowFinished(e.target.checked)}
                  className="w-4 h-4"
                />
                {t('reservations.showFinished')}
              </label>
            </div>
            <div className="flex items-center gap-2 p-3 border-t border-gray-700">
              {filtersActive && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                >
                  {t('reservations.clearFilters')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setListFiltersOpen(false)}
                className="ml-auto px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-rose-900/30 border border-rose-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <div className="relative min-h-[50vh]">
        {/* Mobile: stacked cards (a real table is unusable below ~700px). */}
        <div className="sm:hidden space-y-2">
          {filtered.length === 0 && viewReady && (
            <div className="rounded border border-gray-700 bg-gray-800 p-4 text-center text-sm opacity-70">
              {emptyListMessage}
            </div>
          )}
          {filtered.map((r) => {
            const when = new Date(r.startsAt);
            const hh = String(when.getHours()).padStart(2, '0');
            const mm = String(when.getMinutes()).padStart(2, '0');
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => onRowPress(r)}
                className="w-full text-left rounded border border-gray-700 bg-gray-800 p-3 hover:bg-gray-700/40 active:bg-gray-700/60"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="font-mono text-base shrink-0">
                      {hh}:{mm}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {r.customerName}
                        <span className="opacity-60 text-sm">
                          {' '}
                          · {r.partySize}
                        </span>
                      </div>
                      {r.customerPhone && (
                        <div className="text-xs opacity-70 truncate">
                          {r.customerPhone}
                        </div>
                      )}
                    </div>
                  </div>
                  <StatusChip
                    status={
                      effectiveReservationStatus(r, nowMs) as ReservationStatus
                    }
                  />
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs opacity-80">
                  <span>{r.area}</span>
                  <span>
                    {t('reservations.tablePrefix', {
                      label: r.tableLabel || '—',
                    })}
                  </span>
                </div>
                {r.note && (
                  <div className="mt-1 text-xs opacity-70 truncate">
                    {r.note}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Tablet/desktop: full table. */}
        <div className="hidden sm:block rounded border border-gray-700 bg-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/60 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">
                  {t('reservations.colTime')}
                </th>
                <th className="text-left px-3 py-2">
                  {t('reservations.colCustomer')}
                </th>
                <th className="text-left px-3 py-2">
                  {t('reservations.colParty')}
                </th>
                <th className="text-left px-3 py-2">
                  {t('reservations.colArea')}
                </th>
                <th className="text-left px-3 py-2">
                  {t('reservations.colTable')}
                </th>
                <th className="text-left px-3 py-2">
                  {t('reservations.colStatus')}
                </th>
                <th className="text-left px-3 py-2">
                  {t('reservations.colNote')}
                </th>
                <th className="text-right px-3 py-2">
                  {t('reservations.colActions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && viewReady && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center opacity-70">
                    {emptyListMessage}
                  </td>
                </tr>
              )}
              {filtered.map((r) => {
                const when = new Date(r.startsAt);
                return (
                  <tr
                    key={r.id}
                    className="border-t border-gray-700/60 hover:bg-gray-700/30 cursor-pointer"
                    onClick={() => onRowPress(r)}
                  >
                    <td className="px-3 py-2 font-mono">
                      {String(when.getHours()).padStart(2, '0')}:
                      {String(when.getMinutes()).padStart(2, '0')}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.customerName}</div>
                      {r.customerPhone && (
                        <div className="text-xs opacity-70">
                          {r.customerPhone}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.partySize}</td>
                    <td className="px-3 py-2">{r.area}</td>
                    <td className="px-3 py-2">{r.tableLabel || '—'}</td>
                    <td className="px-3 py-2">
                      <StatusChip
                        status={
                          effectiveReservationStatus(
                            r,
                            nowMs,
                          ) as ReservationStatus
                        }
                      />
                    </td>
                    <td
                      className="px-3 py-2 max-w-xs truncate"
                      title={r.note || ''}
                    >
                      {r.note || '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRowPress(r);
                        }}
                      >
                        {t('reservations.edit')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!viewReady && (
          <div className="absolute inset-0 z-20 bg-gray-900">
            <PageSpinner
              variant="overlay"
              message={t('reservations.loadingReservations')}
            />
          </div>
        )}
      </div>

      {actionRow && actionShown && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 sm:p-4"
          onClick={() => !actionBusy && setActionRow(null)}
        >
          <div
            className="w-full sm:max-w-md bg-gray-800 border border-gray-700 sm:rounded-lg rounded-t-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="flex items-start justify-between p-4 border-b border-gray-700 gap-3">
              <div className="min-w-0">
                <div className="font-mono text-sm opacity-70">
                  {actionHh}:{actionMm}
                  {actionRow.tableLabel
                    ? ` · ${t('reservations.tablePrefix', { label: actionRow.tableLabel })}`
                    : ''}
                </div>
                <div className="text-lg font-semibold truncate">
                  {actionRow.customerName}
                  <span className="opacity-60 font-normal text-base">
                    {' '}
                    · {actionRow.partySize}
                  </span>
                </div>
                <div className="mt-1">
                  <StatusChip status={actionShown} />
                </div>
              </div>
              <button
                type="button"
                className="px-3 py-2 rounded hover:bg-gray-700 text-lg leading-none shrink-0"
                onClick={() => setActionRow(null)}
                disabled={actionBusy}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>
            <div className="p-4 space-y-2">
              {actionError && (
                <div className="text-sm text-rose-300">{actionError}</div>
              )}
              {listQuickStatuses(actionShown).map((s) => {
                const tooEarly = isReservationQuickStatusTooEarly(
                  nowMs,
                  actionRow.startsAt,
                  s,
                );
                const statusLabel = reservationStatusLabel(t, s);
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={actionBusy || tooEarly}
                    className={`w-full px-4 py-3 rounded text-sm font-medium uppercase tracking-wide disabled:opacity-60 ${quickButtonClass(s)}`}
                    onClick={() => void applyListStatus(actionRow, s)}
                    title={
                      tooEarly
                        ? t('reservations.availableFrom', {
                            time: reservationQuickStatusUnlockHint(
                              actionRow.startsAt,
                            ),
                          })
                        : t('reservations.markAsStatus', {
                            status: statusLabel,
                          })
                    }
                  >
                    {statusLabel}
                  </button>
                );
              })}
              <button
                type="button"
                disabled={actionBusy}
                className="w-full px-4 py-3 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium disabled:opacity-60"
                onClick={() => {
                  const row = actionRow;
                  setActionRow(null);
                  openEditor(row);
                }}
              >
                {t('reservations.edit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
