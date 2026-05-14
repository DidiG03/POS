import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { ReservationsContext } from '../ReservationsLayout';
import type { ReservationDTO, ReservationStatus } from '@shared/ipc';

const STATUS_BADGE: Record<ReservationStatus, string> = {
  BOOKED: 'bg-amber-900/60 border-amber-700 text-amber-100',
  SEATED: 'bg-rose-900/60 border-rose-700 text-rose-100',
  COMPLETED: 'bg-emerald-900/60 border-emerald-700 text-emerald-100',
  CANCELLED: 'bg-gray-700/60 border-gray-600 text-gray-200',
  NO_SHOW: 'bg-gray-700/60 border-gray-600 text-gray-300 line-through',
};

function StatusChip({ status }: { status: ReservationStatus }) {
  return (
    <span
      className={`inline-flex items-center text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${STATUS_BADGE[status]}`}
    >
      {status.replace('_', ' ')}
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

export default function ReservationsListPage() {
  const ctx = useOutletContext<ReservationsContext>();
  const { me, area, date, areas, openEditor } = ctx;
  const [reservations, setReservations] = useState<ReservationDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [query, setQuery] = useState('');
  const [areaFilter, setAreaFilter] = useState<string>(''); // '' = all
  // Single-select status filter — '' means "any". A dropdown keeps the
  // toolbar compact enough to fit on one line on tablets.
  const [statusFilter, setStatusFilter] = useState<ReservationStatus | ''>('');
  const [hideClosed, setHideClosed] = useState(false);

  function clearFilters() {
    setQuery('');
    setAreaFilter('');
    setStatusFilter('');
    setHideClosed(false);
  }

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // List doesn't filter by area on this page — hosts often want a global
      // view of the day across all areas.
      const list = await window.api.reservations.list({
        dateIso: date.toISOString(),
      });
      setReservations(list);
    } catch (e: any) {
      setError(e?.message || 'Failed to load reservations');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live updates: refetch when any client mutates a reservation. We always
  // refetch the whole day because the list shows every status (including
  // CANCELLED / NO_SHOW), and we don't have a cheap way to apply a partial
  // patch without re-running the filters. The list is page-sized so this
  // remains snappy.
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
        void reload();
      } catch {
        void reload();
      }
    };
    // Foreground refresh: if SSE missed updates while the tablet was asleep
    // (Android background kill, iOS bfcache), refetch the visible day as
    // soon as the user returns to the panel.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
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
      if (hideClosed && (r.status === 'CANCELLED' || r.status === 'NO_SHOW')) {
        return false;
      }
      if (useStatus && r.status !== statusFilter) return false;
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
  }, [sorted, query, statusFilter, areaFilter, hideClosed]);

  const totalCovers = useMemo(
    () => filtered.reduce((s, r) => s + Number(r.partySize || 0), 0),
    [filtered],
  );

  const filtersActive =
    query.length > 0 ||
    areaFilter.length > 0 ||
    statusFilter !== '' ||
    hideClosed;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm opacity-80">
          {loading
            ? 'Loading…'
            : filtersActive
              ? `${filtered.length} of ${sorted.length} · ${totalCovers} cover${totalCovers === 1 ? '' : 's'}`
              : `${sorted.length} reservation${sorted.length === 1 ? '' : 's'} · ${totalCovers} cover${totalCovers === 1 ? '' : 's'}`}
        </div>
      </div>

      {/* Search + filters — everything fits on a single row from `sm` up.
          On phones controls wrap so each one stays comfortably tappable. */}
      <div className="rounded border border-gray-700 bg-gray-800 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2 sm:flex-nowrap">
          <div className="relative flex-1 sm:min-w-0">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, phone, table or note…"
              // 16px text-base avoids the iOS Safari auto-zoom on focus.
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 pr-8 text-base sm:text-sm"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 px-1.5 rounded hover:bg-gray-700 text-xs opacity-70"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <select
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-2 text-base sm:text-sm sm:shrink-0"
            title="Filter by area"
          >
            <option value="">All areas</option>
            {areas.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as ReservationStatus | '')
            }
            className="bg-gray-900 border border-gray-700 rounded px-2 py-2 text-base sm:text-sm sm:shrink-0"
            title="Filter by status"
          >
            <option value="">Any status</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs opacity-80 whitespace-nowrap sm:shrink-0">
            <input
              type="checkbox"
              checked={hideClosed}
              onChange={(e) => setHideClosed(e.target.checked)}
              className="w-4 h-4"
            />
            Hide cancelled / no-show
          </label>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="sm:ml-auto sm:shrink-0 px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-xs"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-rose-900/30 border border-rose-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {/* Mobile: stacked cards (a real table is unusable below ~700px). */}
      <div className="sm:hidden space-y-2">
        {filtered.length === 0 && !loading && (
          <div className="rounded border border-gray-700 bg-gray-800 p-4 text-center text-sm opacity-70">
            {sorted.length === 0
              ? 'No reservations for this day.'
              : 'No reservations match the current filters.'}
          </div>
        )}
        {filtered.map((r) => {
          const t = new Date(r.startsAt);
          const hh = String(t.getHours()).padStart(2, '0');
          const mm = String(t.getMinutes()).padStart(2, '0');
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => openEditor(r)}
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
                <StatusChip status={r.status} />
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs opacity-80">
                <span>{r.area}</span>
                <span>· Table {r.tableLabel || '—'}</span>
              </div>
              {r.note && (
                <div className="mt-1 text-xs opacity-70 truncate">{r.note}</div>
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
              <th className="text-left px-3 py-2">Time</th>
              <th className="text-left px-3 py-2">Customer</th>
              <th className="text-left px-3 py-2">Party</th>
              <th className="text-left px-3 py-2">Area</th>
              <th className="text-left px-3 py-2">Table</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Note</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center opacity-70">
                  {sorted.length === 0
                    ? 'No reservations for this day.'
                    : 'No reservations match the current filters.'}
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const t = new Date(r.startsAt);
              return (
                <tr
                  key={r.id}
                  className="border-t border-gray-700/60 hover:bg-gray-700/30"
                >
                  <td className="px-3 py-2 font-mono">
                    {String(t.getHours()).padStart(2, '0')}:
                    {String(t.getMinutes()).padStart(2, '0')}
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
                    <StatusChip status={r.status} />
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
                      onClick={() => openEditor(r)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
