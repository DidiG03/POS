import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { ReservationsContext } from '../ReservationsLayout';
import FloorCanvas from '../components/FloorCanvas';
import { HOST_LAYOUT_SCOPE } from '../../stores/reservationSession';
import type { ReservationDTO, ReservationStatus } from '@shared/ipc';
import {
  isReservationQuickStatusTooEarly,
  reservationQuickStatusUnlockHint,
} from '../../utils/reservationStatusWindow';

// Quick-action statuses surfaced in the per-table sheet.
const QUICK_STATUSES: ReservationStatus[] = [
  'SEATED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
];

function statusChipClass(s: ReservationStatus): string {
  switch (s) {
    case 'BOOKED':
      return 'bg-amber-700/40 border-amber-600 text-amber-200';
    case 'SEATED':
      return 'bg-rose-700/40 border-rose-600 text-rose-200';
    case 'COMPLETED':
      return 'bg-emerald-800/40 border-emerald-700 text-emerald-200';
    case 'NO_SHOW':
      return 'bg-gray-700/60 border-gray-500 text-gray-200';
    case 'CANCELLED':
      return 'bg-zinc-700/60 border-zinc-500 text-zinc-300 line-through';
  }
}

function quickButtonClass(s: ReservationStatus): string {
  switch (s) {
    case 'SEATED':
      return 'bg-rose-700 hover:bg-rose-600';
    case 'COMPLETED':
      return 'bg-emerald-700 hover:bg-emerald-600';
    case 'NO_SHOW':
      return 'bg-gray-600 hover:bg-gray-500';
    case 'CANCELLED':
      return 'bg-zinc-700 hover:bg-zinc-600';
    default:
      return 'bg-gray-700 hover:bg-gray-600';
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
}

// Strip Electron's verbose IPC error wrapper so the user sees the friendly text.
function cleanIpcMessage(e: any): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return 'Something went wrong.';
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || 'Something went wrong.';
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Only "live" reservations occupy a table on the floor. Once a reservation is
// COMPLETED, NO_SHOW, or CANCELLED the table is considered free again — the
// historical record stays visible on the List view.
function isLive(r: ReservationDTO): boolean {
  return r.status === 'BOOKED' || r.status === 'SEATED';
}

function colorForReservation(
  rs: ReservationDTO[] | undefined,
  isToday: boolean,
): string {
  const live = (rs || []).filter(isLive);
  if (!live.length) return 'bg-emerald-700';
  // Priority: SEATED > BOOKED soon > BOOKED later.
  if (live.some((r) => r.status === 'SEATED')) return 'bg-rose-700';
  const booked = live.filter((r) => r.status === 'BOOKED');
  if (!isToday) return 'bg-amber-600';
  const now = Date.now();
  const soon = booked.find((r) => {
    const t = new Date(r.startsAt).getTime();
    return Math.abs(t - now) <= 30 * 60 * 1000;
  });
  return soon ? 'bg-blue-600' : 'bg-amber-600';
}

function badgeForReservation(rs: ReservationDTO[] | undefined): string | null {
  const live = (rs || []).filter(isLive);
  if (!live.length) return null;
  const sorted = [...live].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const first = sorted[0];
  const t = new Date(first.startsAt);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const more = sorted.length > 1 ? `+${sorted.length - 1}` : '';
  return more ? `${hh}:${mm} ${more}` : `${hh}:${mm}`;
}

export default function ReservationsFloorPage() {
  const ctx = useOutletContext<ReservationsContext>();
  const { me, area, date, openEditor, notifyReservationsChanged } = ctx;
  const [reservations, setReservations] = useState<ReservationDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When non-null, the per-table reservations sheet is open for this label.
  const [sheetLabel, setSheetLabel] = useState<string | null>(null);
  const [sheetBusyId, setSheetBusyId] = useState<number | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetNowMs, setSheetNowMs] = useState(() => Date.now());

  const isToday = isSameLocalDay(date, new Date());

  useEffect(() => {
    if (!sheetLabel) return;
    setSheetNowMs(Date.now());
    const id = window.setInterval(() => setSheetNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [sheetLabel]);

  // Load reservations for the selected day + area.
  const reload = useCallback(async () => {
    if (!area) {
      setReservations([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await window.api.reservations.list({
        dateIso: date.toISOString(),
        area,
      });
      setReservations(list);
    } catch (e: any) {
      setError(e?.message || 'Failed to load reservations');
    } finally {
      setLoading(false);
    }
  }, [area, date]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live updates: when ANY client mutates a reservation, the main process
  // broadcasts a `pos:reservationsChanged` window event (via SSE on mobile
  // / IPC on Electron). We refetch only when the change touches the day +
  // area we're currently showing — events on other days are ignored to
  // keep the floor view smooth on a busy host.
  useEffect(() => {
    const onChanged = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as {
          dateIso?: string;
          area?: string | null;
        };
        const evDate = detail.dateIso ? new Date(detail.dateIso) : null;
        if (evDate && !isSameLocalDay(evDate, date)) return;
        if (detail.area && area && String(detail.area) !== String(area)) return;
        void reload();
      } catch {
        // be defensive — never crash the floor view on a bad payload
        void reload();
      }
    };
    // Visibility / focus: when the tablet was backgrounded for longer than
    // the SSE health watchdog could ride out, we may have missed events
    // entirely. A best-effort refresh on resume keeps the floor honest.
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
  }, [reload, date, area]);

  const reservationsByLabel = useMemo(() => {
    const map = new Map<string, ReservationDTO[]>();
    for (const r of reservations) {
      const k = r.tableLabel || '';
      if (!k) continue;
      const arr = map.get(k) || [];
      arr.push(r);
      map.set(k, arr);
    }
    return map;
  }, [reservations]);

  const colorByLabel = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [label, rs] of reservationsByLabel.entries()) {
      out[label] = colorForReservation(rs, isToday);
    }
    return out;
  }, [reservationsByLabel, isToday]);

  const badgeByLabel = useMemo(() => {
    const out: Record<string, string | null | undefined> = {};
    for (const [label, rs] of reservationsByLabel.entries()) {
      out[label] = badgeForReservation(rs);
    }
    return out;
  }, [reservationsByLabel]);

  function openTableSheet(label: string) {
    const all = reservationsByLabel.get(label) || [];
    // A free table (no history at all) goes straight to the new-reservation form.
    if (all.length === 0) {
      openEditor({ tableLabel: label, area });
      return;
    }
    setSheetError(null);
    setSheetBusyId(null);
    setSheetLabel(label);
  }

  async function applyStatus(r: ReservationDTO, status: ReservationStatus) {
    if (!me?.id) return;
    setSheetBusyId(r.id);
    setSheetError(null);
    try {
      const updated = await window.api.reservations.setStatus({
        id: r.id,
        actorId: me.id,
        status,
      });
      // Refresh this device immediately (and re-broadcast for any same-window
      // listeners). SSE will still notify other devices via the main-process
      // broadcast inside the service.
      notifyReservationsChanged(
        'status',
        updated?.startsAt || r.startsAt,
        updated?.area || r.area,
      );
      await reload();
    } catch (e) {
      setSheetError(cleanIpcMessage(e));
    } finally {
      setSheetBusyId(null);
    }
  }

  // Pull the latest reservations for the currently-open sheet so it stays in
  // sync after a status change without closing the modal.
  const sheetReservations = useMemo(() => {
    if (!sheetLabel) return [] as ReservationDTO[];
    const arr = reservationsByLabel.get(sheetLabel) || [];
    return [...arr].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
  }, [reservationsByLabel, sheetLabel]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2 flex-wrap">
        <div className="text-sm opacity-80">
          {loading
            ? 'Loading reservations…'
            : `${reservations.length} reservation${
                reservations.length === 1 ? '' : 's'
              } in ${area || '—'}`}
        </div>
        <div className="hidden sm:flex items-center gap-3 text-xs flex-wrap sm:ml-auto">
          <Legend cls="bg-emerald-700" label="Free" />
          <Legend cls="bg-amber-600" label="Booked" />
          <Legend cls="bg-blue-600" label="Soon (±30m)" />
          <Legend cls="bg-rose-700" label="Seated" />
        </div>
      </div>

      {!area && (
        <div className="shrink-0 bg-amber-900/30 border border-amber-700 rounded p-3 text-sm">
          No area configured. Ask an Admin to add at least one Table Area in
          Settings.
        </div>
      )}

      {error && (
        <div className="shrink-0 bg-rose-900/30 border border-rose-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {area && me?.id ? (
        <FloorCanvas
          userId={me.id}
          area={area}
          scope={HOST_LAYOUT_SCOPE}
          editable={false}
          fillAvailableHeight
          colorByLabel={colorByLabel}
          badgeByLabel={badgeByLabel}
          onTableClick={(label) => openTableSheet(label)}
          defaultCount={ctx.areas.find((a) => a.name === area)?.count ?? 8}
        />
      ) : null}

      {/* Tables-without-a-table-assignment surface: show as a pill list */}
      {reservations.some((r) => !r.tableLabel) && (
        <div className="shrink-0 rounded border border-gray-700 bg-gray-800 p-3">
          <div className="text-xs uppercase tracking-wide opacity-70 mb-2">
            Reservations without a table
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {reservations
              .filter((r) => !r.tableLabel)
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                  onClick={() => openEditor(r)}
                >
                  {new Date(r.startsAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}{' '}
                  • {r.customerName} ({r.partySize})
                </button>
              ))}
          </div>
        </div>
      )}

      {sheetLabel && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 sm:p-4"
          onClick={() => setSheetLabel(null)}
        >
          <div
            className="w-full sm:max-w-2xl h-[92dvh] sm:h-auto bg-gray-800 border border-gray-700 sm:rounded-lg rounded-t-2xl shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
            style={{
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide opacity-70">
                  {area}
                </div>
                <div className="text-lg font-semibold truncate">
                  Table {sheetLabel}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-3 py-2 sm:py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm whitespace-nowrap"
                  onClick={() => {
                    openEditor({ tableLabel: sheetLabel, area });
                    setSheetLabel(null);
                  }}
                >
                  + New
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded hover:bg-gray-700 text-lg leading-none"
                  onClick={() => setSheetLabel(null)}
                  title="Close"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            {sheetError && (
              <div className="mx-4 mt-3 text-sm text-rose-300">
                {sheetError}
              </div>
            )}

            <div className="flex-1 overflow-y-auto divide-y divide-gray-700/70 sm:max-h-[70vh]">
              {sheetReservations.length === 0 ? (
                <div className="p-4 text-sm opacity-70">
                  No reservations on this table for the selected day.
                </div>
              ) : (
                sheetReservations.map((r) => {
                  const busy = sheetBusyId === r.id;
                  const isClosed = !isLive(r);
                  return (
                    <div key={r.id} className="p-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="font-mono text-sm w-12 shrink-0">
                          {formatTime(r.startsAt)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">
                            {r.customerName}{' '}
                            <span className="opacity-60 text-sm">
                              · {r.partySize}
                            </span>
                          </div>
                          <div className="text-xs opacity-60 truncate">
                            {r.customerPhone || '—'}
                            {r.note ? ` · ${r.note}` : ''}
                          </div>
                        </div>
                        <span
                          className={`text-[10px] uppercase tracking-wide border px-2 py-0.5 rounded ${statusChipClass(
                            r.status,
                          )}`}
                        >
                          {r.status.replace('_', ' ')}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
                          onClick={() => {
                            openEditor(r);
                            setSheetLabel(null);
                          }}
                        >
                          Edit
                        </button>
                      </div>

                      <div className="mt-2 flex items-center gap-1.5 flex-wrap pl-[3.75rem]">
                        {QUICK_STATUSES.filter((s) => s !== r.status).map(
                          (s) => {
                            const tooEarly = isReservationQuickStatusTooEarly(
                              sheetNowMs,
                              r.startsAt,
                              s,
                            );
                            const unlockAt = reservationQuickStatusUnlockHint(
                              r.startsAt,
                            );
                            return (
                              <button
                                key={s}
                                type="button"
                                disabled={busy || tooEarly}
                                className={`px-2 py-1 rounded text-[11px] uppercase tracking-wide disabled:opacity-60 ${quickButtonClass(
                                  s,
                                )}`}
                                onClick={() => void applyStatus(r, s)}
                                title={
                                  tooEarly
                                    ? `Available from ${unlockAt} (15 min before reservation)`
                                    : `Mark as ${s.replace('_', ' ')}`
                                }
                              >
                                {s.replace('_', ' ')}
                              </button>
                            );
                          },
                        )}
                        {isClosed && (
                          <button
                            type="button"
                            disabled={busy}
                            className="px-2 py-1 rounded text-[11px] uppercase tracking-wide bg-amber-700 hover:bg-amber-600 disabled:opacity-60"
                            onClick={() => void applyStatus(r, 'BOOKED')}
                            title="Re-open as Booked"
                          >
                            Re-open
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
      <span className="opacity-80">{label}</span>
    </div>
  );
}
