import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReservationsContext } from '../ReservationsLayout';
import FloorCanvas from '../components/FloorCanvas';
import { HOST_LAYOUT_SCOPE } from '../../stores/reservationSession';
import type { ReservationDTO, ReservationStatus } from '@shared/ipc';
import {
  formatMergeLabel,
  sanitizeMergeGroups,
  separateTableGroup,
  type TableMergeGroup,
} from '@shared/tableMerge';
import { toast } from '../../stores/toasts';
import {
  isReservationQuickStatusTooEarly,
  reservationQuickStatusUnlockHint,
} from '../../utils/reservationStatusWindow';
import { reservationStatusLabel } from '../../utils/reservationLabels';
import {
  RESERVATION_TABLE_FREE_CLASS,
  isLiveReservation,
  reservationTableColorClass,
} from '../../utils/reservationFloorColor';
import { PageSpinner } from '../../components/PageSpinner';
import { afterPaint } from '../../utils/afterPaint';
import {
  distinctSeatedAt,
  effectiveReservationStatus,
  formatReservationClock,
  formatReservationDuration,
  reservationEndMs,
  reservationOccupancyStartMs,
  reservationOccupiesTable,
} from '@shared/reservationDuration';

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
      return 'bg-zinc-700/60 border-zinc-500 text-zinc-200';
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
      return 'bg-zinc-600 hover:bg-zinc-500';
    case 'NO_SHOW':
      return 'bg-gray-600 hover:bg-gray-500';
    case 'CANCELLED':
      return 'bg-zinc-700 hover:bg-zinc-600';
    default:
      return 'bg-gray-700 hover:bg-gray-600';
  }
}

function occupyingLiveReservation(
  rs: ReservationDTO[] | undefined,
  nowMs: number,
): ReservationDTO | null {
  const live = (rs || []).filter((r) => reservationOccupiesTable(r, nowMs));
  if (!live.length) return null;
  const seated = live.find(
    (r) => effectiveReservationStatus(r, nowMs) === 'SEATED',
  );
  if (seated) return seated;
  return [...live].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  )[0];
}

function occupyingAnyReservation(
  labels: string[],
  byLabel: Map<string, ReservationDTO[]>,
  nowMs: number,
): ReservationDTO | null {
  for (const label of labels) {
    const live = occupyingLiveReservation(byLabel.get(label), nowMs);
    if (live) return live;
  }
  return null;
}

function reservationsForLabels(
  labels: string[],
  byLabel: Map<string, ReservationDTO[]>,
): ReservationDTO[] {
  const seen = new Set<number>();
  const out: ReservationDTO[] = [];
  for (const label of labels) {
    for (const r of byLabel.get(label) || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

function menuStatusesFor(status: ReservationStatus): ReservationStatus[] {
  if (status === 'SEATED') return ['COMPLETED', 'CANCELLED'];
  if (status === 'BOOKED') return ['SEATED', 'NO_SHOW', 'CANCELLED'];
  return [];
}

function clampMenuPos(x: number, y: number, width = 224, height = 360) {
  const pad = 8;
  const left = Math.max(pad, Math.min(x, window.innerWidth - width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - height - pad));
  return { left, top };
}

function formatTime(iso: string): string {
  return formatReservationClock(iso);
}

// Strip Electron's verbose IPC error wrapper so the user sees the friendly text.
function cleanIpcMessage(e: any, fallback: string): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return fallback;
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || fallback;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function badgeForReservation(
  rs: ReservationDTO[] | undefined,
  nowMs: number,
): string | null {
  const live = (rs || []).filter((r) => reservationOccupiesTable(r, nowMs));
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
  const { t } = useTranslation();
  const ctx = useOutletContext<ReservationsContext>();
  const { me, area, date, openEditor, openWalkIn, notifyReservationsChanged } =
    ctx;
  const [reservations, setReservations] = useState<ReservationDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [layoutReadyArea, setLayoutReadyArea] = useState<string | null>(null);
  const [resReadyKey, setResReadyKey] = useState<string | null>(null);
  const [viewReadyKey, setViewReadyKey] = useState<string | null>(null);
  // When non-null, the per-table reservations sheet is open for this label.
  const [sheetLabel, setSheetLabel] = useState<string | null>(null);
  const [sheetMembers, setSheetMembers] = useState<string[]>([]);
  const [sheetBusyId, setSheetBusyId] = useState<number | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetNowMs, setSheetNowMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [tableMenu, setTableMenu] = useState<{
    label: string;
    members: string[];
    x: number;
    y: number;
  } | null>(null);
  const [mergeGroups, setMergeGroups] = useState<TableMergeGroup[]>([]);
  const [menuError, setMenuError] = useState<string | null>(null);
  const reloadGen = useRef(0);
  const isToday = isSameLocalDay(date, new Date());
  const snapshotKey = `${area}|${date.toISOString()}`;
  const contentReady =
    !area || (layoutReadyArea === area && resReadyKey === snapshotKey);
  const viewReady = !area || viewReadyKey === snapshotKey;

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!tableMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTableMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tableMenu]);

  useEffect(() => {
    if (!sheetLabel) return;
    setSheetNowMs(Date.now());
    const id = window.setInterval(() => setSheetNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [sheetLabel]);

  // Load reservations for the selected day + area.
  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      const gen = ++reloadGen.current;
      const myKey = `${area}|${date.toISOString()}`;
      if (!area) {
        setReservations([]);
        setResReadyKey(myKey);
        return;
      }
      setError(null);
      try {
        const list = await window.api.reservations.list({
          dateIso: date.toISOString(),
          area,
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
    [area, date, t],
  );

  useEffect(() => {
    void reload({ silent: false });
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
        void reload({ silent: true });
      } catch {
        // be defensive — never crash the floor view on a bad payload
        void reload({ silent: true });
      }
    };
    // Visibility / focus: when the tablet was backgrounded for longer than
    // the SSE health watchdog could ride out, we may have missed events
    // entirely. A best-effort refresh on resume keeps the floor honest.
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
  }, [reload, date, area]);

  const reloadMerges = useCallback(async () => {
    if (!area) {
      setMergeGroups([]);
      return;
    }
    const groups = await window.api.layout.getMerges(area).catch(() => []);
    setMergeGroups(sanitizeMergeGroups(groups));
  }, [area]);

  useEffect(() => {
    void reloadMerges();
  }, [reloadMerges]);

  useEffect(() => {
    const onMerges = (ev: any) => {
      const detail = (ev?.detail || {}) as { area?: string };
      if (detail.area && area && String(detail.area) !== String(area)) return;
      void reloadMerges();
    };
    window.addEventListener('pos:tableMergesChanged', onMerges);
    return () => window.removeEventListener('pos:tableMergesChanged', onMerges);
  }, [area, reloadMerges]);

  const commitMerges = useCallback(
    async (next: TableMergeGroup[]) => {
      const sanitized = sanitizeMergeGroups(next);
      setMergeGroups(sanitized);
      try {
        const saved = await window.api.layout.setMerges(area, sanitized);
        setMergeGroups(sanitizeMergeGroups(saved));
      } catch (e) {
        const msg = cleanIpcMessage(e, t('reservations.somethingWrong'));
        toast.error(
          /forbidden/i.test(msg) ? t('reservations.mergeForbidden') : msg,
        );
        await reloadMerges();
      }
    },
    [area, reloadMerges, t],
  );

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
      out[label] = reservationTableColorClass(rs, isToday, nowMs);
    }
    return out;
  }, [reservationsByLabel, isToday, nowMs]);

  const badgeByLabel = useMemo(() => {
    const out: Record<string, string | null | undefined> = {};
    for (const [label, rs] of reservationsByLabel.entries()) {
      out[label] = badgeForReservation(rs, nowMs);
    }
    return out;
  }, [reservationsByLabel, nowMs]);

  // Reveal only after layout tables + reservation colours are committed
  // and painted. Background refetches keep the same key and do not flash.
  useEffect(() => {
    if (!contentReady) return;
    return afterPaint(() => setViewReadyKey(snapshotKey));
  }, [contentReady, snapshotKey, colorByLabel]);

  function openTableSheet(label: string, members?: string[]) {
    const labels = (members?.length ? members : [label]).filter(Boolean);
    const all = reservationsForLabels(labels, reservationsByLabel);
    // A free table (no history at all) goes straight to the new-reservation form.
    if (all.length === 0) {
      openEditor({ tableLabel: labels[0] || label, area });
      return;
    }
    setSheetError(null);
    setSheetBusyId(null);
    setTableMenu(null);
    setSheetMembers(labels);
    setSheetLabel(formatMergeLabel(labels));
  }

  function closeTableSheet() {
    setSheetLabel(null);
    setSheetMembers([]);
  }

  function openTableMenu(info: {
    label: string;
    members?: string[];
    clientX: number;
    clientY: number;
  }) {
    setMenuError(null);
    const members = info.members?.length ? info.members : [info.label];
    setTableMenu({
      label: info.label,
      members,
      x: info.clientX,
      y: info.clientY,
    });
  }

  async function separateMergedTables() {
    if (!tableMenu || tableMenu.members.length < 2) return;
    const next = separateTableGroup(mergeGroups, tableMenu.label);
    setTableMenu(null);
    await commitMerges(next);
  }

  async function applyStatus(
    r: ReservationDTO,
    status: ReservationStatus,
    fromMenu = false,
  ) {
    if (!me?.id) return;
    setSheetBusyId(r.id);
    setSheetError(null);
    setMenuError(null);
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
      await reload({ silent: true });
      if (fromMenu) setTableMenu(null);
    } catch (e) {
      const msg = cleanIpcMessage(e, t('reservations.somethingWrong'));
      if (fromMenu) setMenuError(msg);
      else setSheetError(msg);
    } finally {
      setSheetBusyId(null);
    }
  }

  // Pull the latest reservations for the currently-open sheet so it stays in
  // sync after a status change without closing the modal.
  const sheetReservations = useMemo(() => {
    if (!sheetLabel) return [] as ReservationDTO[];
    const labels = sheetMembers.length ? sheetMembers : [sheetLabel];
    return reservationsForLabels(labels, reservationsByLabel).sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
  }, [reservationsByLabel, sheetLabel, sheetMembers]);

  const sheetPrimaryLabel = sheetMembers[0] || sheetLabel || '';

  const menuMembers = tableMenu?.members?.length
    ? tableMenu.members
    : tableMenu
      ? [tableMenu.label]
      : [];
  const menuLive = tableMenu
    ? occupyingAnyReservation(menuMembers, reservationsByLabel, nowMs)
    : null;
  const menuShown = menuLive
    ? (effectiveReservationStatus(menuLive, nowMs) as ReservationStatus)
    : null;
  const menuSeated = menuLive
    ? distinctSeatedAt(menuLive.startsAt, menuLive.seatedAt)
    : null;
  const menuPos = tableMenu
    ? clampMenuPos(tableMenu.x, tableMenu.y)
    : { left: 0, top: 0 };
  const menuHasHistory = tableMenu
    ? reservationsForLabels(menuMembers, reservationsByLabel).length > 0
    : false;
  const menuMerged = menuMembers.length > 1;
  const menuDisplayLabel = menuMembers.length
    ? formatMergeLabel(menuMembers)
    : tableMenu?.label || '';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2 flex-wrap">
        <div className="text-sm opacity-80">
          {viewReady
            ? t('reservations.countInArea', {
                count: reservations.length,
                area: area || '—',
              })
            : t('reservations.loadingReservations')}
        </div>
        <div className="hidden sm:flex items-center gap-3 text-xs flex-wrap sm:ml-auto">
          <Legend
            cls={RESERVATION_TABLE_FREE_CLASS}
            label={t('reservations.legendFree')}
          />
          <Legend cls="bg-amber-600" label={t('reservations.legendBooked')} />
          <Legend cls="bg-blue-600" label={t('reservations.legendSoon')} />
          <Legend cls="bg-rose-700" label={t('reservations.legendSeated')} />
        </div>
      </div>

      {!area && (
        <div className="shrink-0 bg-amber-900/30 border border-amber-700 rounded p-3 text-sm">
          {t('reservations.noAreaConfigured')}
        </div>
      )}

      {error && (
        <div className="shrink-0 bg-rose-900/30 border border-rose-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {area && me?.id ? (
        <div className="relative min-h-0 flex-1 flex flex-col">
          <FloorCanvas
            userId={me.id}
            area={area}
            scope={HOST_LAYOUT_SCOPE}
            editable={false}
            fillAvailableHeight
            colorByLabel={colorByLabel}
            unlistedColorClass={RESERVATION_TABLE_FREE_CLASS}
            badgeByLabel={badgeByLabel}
            onTableClick={(label, members) => openTableSheet(label, members)}
            onTableLongPress={openTableMenu}
            onLayoutReady={({ area: readyArea }) =>
              setLayoutReadyArea(readyArea)
            }
            mergeEnabled
            mergeGroups={mergeGroups}
            isTableOccupied={(label) =>
              occupyingLiveReservation(reservationsByLabel.get(label), nowMs) !=
              null
            }
            onCommitMerges={(groups) => void commitMerges(groups)}
            onMergeBlocked={() => toast.error(t('reservations.mergeOccupied'))}
          />
          {!viewReady && (
            <div className="absolute inset-0 z-20 bg-gray-900">
              <PageSpinner
                variant="overlay"
                message={t('reservations.loadingReservations')}
              />
            </div>
          )}
        </div>
      ) : null}

      {/* Tables-without-a-table-assignment surface: show as a pill list */}
      {viewReady && reservations.some((r) => !r.tableLabel) && (
        <div className="shrink-0 rounded border border-gray-700 bg-gray-800 p-3">
          <div className="text-xs uppercase tracking-wide opacity-70 mb-2">
            {t('reservations.withoutTable')}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {reservations
              .filter((r) => !r.tableLabel)
              .map((r) => {
                const seatedAt = distinctSeatedAt(r.startsAt, r.seatedAt);
                return (
                  <button
                    key={r.id}
                    type="button"
                    className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                    onClick={() => openEditor(r)}
                  >
                    {formatTime(r.startsAt)}
                    {seatedAt
                      ? ` · ${t('reservations.timeSeated')} ${formatReservationClock(seatedAt)}`
                      : ''}{' '}
                    • {r.customerName} ({r.partySize})
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {sheetLabel && (
        <div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/60 sm:p-4"
          onClick={() => closeTableSheet()}
        >
          <div
            className="w-full sm:max-w-2xl h-[92dvh] sm:h-auto bg-gray-800 border border-gray-700 sm:rounded-lg rounded-t-2xl shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
            style={{
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <div className="flex items-center justify-between p-4 pb-3 border-b border-gray-700 gap-2">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide opacity-70">
                  {area}
                </div>
                <div className="text-lg font-semibold truncate">
                  {t('reservations.tableLabel', { label: sheetLabel })}
                </div>
              </div>
              <button
                type="button"
                className="px-3 py-2 rounded hover:bg-gray-700 text-lg leading-none shrink-0"
                onClick={() => closeTableSheet()}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 px-4 py-3 border-b border-gray-700">
              <button
                type="button"
                className="px-3 py-2 rounded bg-rose-700 hover:bg-rose-600 text-sm font-medium"
                onClick={() => {
                  openWalkIn({ tableLabel: sheetPrimaryLabel });
                  closeTableSheet();
                }}
                title={t('reservations.seatNowTitle')}
              >
                {t('reservations.seatNow')}
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium"
                onClick={() => {
                  openEditor({ tableLabel: sheetPrimaryLabel, area });
                  closeTableSheet();
                }}
                title={t('reservations.newReservationTitle')}
              >
                {t('reservations.newReservation')}
              </button>
            </div>

            {sheetError && (
              <div className="mx-4 mt-3 text-sm text-rose-300">
                {sheetError}
              </div>
            )}

            <div className="flex-1 overflow-y-auto divide-y divide-gray-700/70 sm:max-h-[70vh]">
              {sheetReservations.length === 0 ? (
                <div className="p-4 text-sm opacity-70">
                  {t('reservations.noReservationsOnTable')}
                </div>
              ) : (
                sheetReservations.map((r) => {
                  const busy = sheetBusyId === r.id;
                  const shownStatus = effectiveReservationStatus(
                    r,
                    sheetNowMs,
                  ) as ReservationStatus;
                  const isClosed = !isLiveReservation(shownStatus);
                  const occupyStart = reservationOccupancyStartMs(r);
                  const endMs =
                    occupyStart != null
                      ? reservationEndMs(new Date(occupyStart), r.durationMin)
                      : null;
                  const seatedAt = distinctSeatedAt(r.startsAt, r.seatedAt);
                  return (
                    <div key={r.id} className="p-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="shrink-0">
                          <div className="font-mono text-sm">
                            {formatTime(r.startsAt)}
                          </div>
                          {seatedAt ? (
                            <>
                              <div className="text-[10px] leading-tight opacity-55">
                                {t('reservations.timeReserved')}
                              </div>
                              <div className="font-mono text-sm mt-1">
                                {formatReservationClock(seatedAt)}
                              </div>
                              <div className="text-[10px] leading-tight opacity-55">
                                {t('reservations.timeSeated')}
                              </div>
                            </>
                          ) : null}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">
                            {r.customerName}{' '}
                            <span className="opacity-60 text-sm">
                              · {r.partySize}
                            </span>
                          </div>
                          <div className="text-xs opacity-60 truncate">
                            {formatReservationDuration(r.durationMin)}
                            {endMs
                              ? ` · ${t('reservations.until', {
                                  time: formatTime(
                                    new Date(endMs).toISOString(),
                                  ),
                                })}`
                              : ''}
                            {r.customerPhone ? ` · ${r.customerPhone}` : ''}
                            {r.note ? ` · ${r.note}` : ''}
                          </div>
                        </div>
                        <span
                          className={`text-[10px] uppercase tracking-wide border px-2 py-0.5 rounded ${statusChipClass(
                            shownStatus,
                          )}`}
                        >
                          {reservationStatusLabel(t, shownStatus)}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
                          onClick={() => {
                            openEditor(r);
                            closeTableSheet();
                          }}
                        >
                          {t('reservations.edit')}
                        </button>
                      </div>

                      <div className="mt-2 flex items-center gap-1.5 flex-wrap pl-16">
                        {QUICK_STATUSES.filter((s) => s !== shownStatus).map(
                          (s) => {
                            const tooEarly = isReservationQuickStatusTooEarly(
                              sheetNowMs,
                              r.startsAt,
                              s,
                            );
                            const unlockAt = reservationQuickStatusUnlockHint(
                              r.startsAt,
                            );
                            const statusLabel = reservationStatusLabel(t, s);
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
                                    ? t('reservations.availableFrom', {
                                        time: unlockAt,
                                      })
                                    : t('reservations.markAsStatus', {
                                        status: statusLabel,
                                      })
                                }
                              >
                                {statusLabel}
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
                            title={t('reservations.reopenTitle')}
                          >
                            {t('reservations.reopen')}
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

      {tableMenu && (
        <div className="fixed inset-0 z-50" onClick={() => setTableMenu(null)}>
          <div
            role="menu"
            className="absolute w-56 rounded-lg border border-gray-600 bg-gray-800 shadow-2xl overflow-hidden"
            style={{ left: menuPos.left, top: menuPos.top }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-gray-700">
              <div className="text-[10px] uppercase tracking-wide opacity-60">
                {t('reservations.quickMenu')}
              </div>
              <div className="font-semibold truncate">
                {t('reservations.tableLabel', { label: menuDisplayLabel })}
              </div>
              {menuLive ? (
                <div className="text-xs opacity-70 truncate mt-0.5">
                  {formatTime(menuLive.startsAt)}
                  {menuSeated
                    ? ` · ${t('reservations.timeSeated')} ${formatReservationClock(menuSeated)}`
                    : ''}
                  {' · '}
                  {menuLive.customerName}
                </div>
              ) : (
                <div className="text-xs opacity-60 mt-0.5">
                  {t('reservations.legendFree')}
                </div>
              )}
            </div>
            {menuError && (
              <div className="px-3 py-2 text-xs text-rose-300">{menuError}</div>
            )}
            <div className="p-1.5 space-y-1">
              {menuLive &&
                menuShown &&
                menuStatusesFor(menuShown).map((s) => {
                  const tooEarly = isReservationQuickStatusTooEarly(
                    nowMs,
                    menuLive.startsAt,
                    s,
                  );
                  const label =
                    s === 'SEATED'
                      ? t('reservations.seatGuest')
                      : s === 'COMPLETED'
                        ? t('reservations.finishStay')
                        : reservationStatusLabel(t, s);
                  return (
                    <button
                      key={s}
                      type="button"
                      role="menuitem"
                      disabled={Boolean(sheetBusyId) || tooEarly}
                      className={`w-full text-left px-3 py-2 rounded text-sm font-medium disabled:opacity-50 ${quickButtonClass(s)}`}
                      title={
                        tooEarly
                          ? t('reservations.availableFrom', {
                              time: reservationQuickStatusUnlockHint(
                                menuLive.startsAt,
                              ),
                            })
                          : undefined
                      }
                      onClick={() => void applyStatus(menuLive, s, true)}
                    >
                      {label}
                    </button>
                  );
                })}
              {!menuLive && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-3 py-2 rounded text-sm font-medium bg-rose-700 hover:bg-rose-600"
                    onClick={() => {
                      openWalkIn({ tableLabel: tableMenu.label });
                      setTableMenu(null);
                    }}
                  >
                    {t('reservations.seatNow')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-3 py-2 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500"
                    onClick={() => {
                      openEditor({ tableLabel: tableMenu.label, area });
                      setTableMenu(null);
                    }}
                  >
                    {t('reservations.newReservation')}
                  </button>
                </>
              )}
              {menuLive && (
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-3 py-2 rounded text-sm bg-gray-700 hover:bg-gray-600"
                  onClick={() => {
                    openEditor(menuLive);
                    setTableMenu(null);
                  }}
                >
                  {t('reservations.edit')}
                </button>
              )}
              {menuHasHistory && (
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-3 py-2 rounded text-sm bg-gray-700 hover:bg-gray-600"
                  onClick={() =>
                    openTableSheet(tableMenu.label, tableMenu.members)
                  }
                >
                  {t('reservations.viewBookings')}
                </button>
              )}
              {menuMerged && (
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-3 py-2 rounded text-sm font-medium bg-amber-700 hover:bg-amber-600"
                  onClick={() => void separateMergedTables()}
                >
                  {t('reservations.separateTables')}
                </button>
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
