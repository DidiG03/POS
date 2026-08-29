import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useReservationSessionStore,
  HOST_LAYOUT_SCOPE,
} from '../stores/reservationSession';
import ReservationEditor from './components/ReservationEditor';
import WalkInDialog from './components/WalkInDialog';
import {
  dispatchReservationsChanged,
  type ReservationsChangedKind,
} from '../utils/reservationEvents';
import type { ReservationDTO } from '@shared/ipc';
import { pickConfiguredArea, saneTableAreas } from '@shared/tableAreas';
import {
  reservationEndMs,
  reservationOccupancyStartMs,
  reservationOccupiesTable,
  reservationStayElapsed,
} from '@shared/reservationDuration';
import { ReservationTimeUpDialog } from './components/ReservationTimeUpDialog';

export type ReservationsContext = {
  me: { id: number; displayName: string; role: string };
  area: string;
  setArea: (a: string) => void;
  areas: { name: string; count: number }[];
  date: Date; // local-day anchor (always normalized to start-of-day)
  setDate: (d: Date) => void;
  goRelativeDays: (delta: number) => void;
  // Shared lookup tables (computed once in the layout so every page sees the
  // same data and the editor / walk-in dialog can be triggered from anywhere).
  tableLabels: string[];
  freeTableLabels: string[];
  openEditor: (initial?: Partial<ReservationDTO> | null) => void;
  openWalkIn: (opts?: { tableLabel?: string }) => void;
  /** List view: Sot sits in this layout; Filtrat opens the list filter sheet. */
  listFiltersOpen: boolean;
  setListFiltersOpen: (open: boolean) => void;
  listFiltersActive: boolean;
  setListFiltersActive: (active: boolean) => void;
  /**
   * Same-device refresh signal. The Floor and List pages already react to
   * `pos:reservationsChanged` (SSE/IPC from other devices), but when the
   * tablet that *made* the change is offline-from-SSE (Android often kills
   * the EventSource when the WebView backgrounds), the broadcast loop never
   * round-trips. Pages and embedded dialogs call this helper after a
   * successful mutation so the local view refreshes immediately without
   * waiting on the broadcast.
   */
  notifyReservationsChanged: (
    kind: ReservationsChangedKind,
    dateIso?: string | null,
    area?: string | null,
  ) => void;
};

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Extract TABLE labels from persisted layout JSON (excludes AREA / decor). */
function labelsFromLayoutNodes(saved: any[] | null | undefined): string[] {
  if (!Array.isArray(saved) || !saved.length) return [];
  const out: string[] = [];
  for (const n of saved) {
    if (!n) continue;
    const kind = n.kind;
    if (String(kind || '').toUpperCase() === 'AREA') continue;
    if (kind != null && kind !== '' && String(kind).toUpperCase() !== 'TABLE') {
      continue;
    }
    const lab = String(n.label || '').trim();
    if (lab) out.push(lab);
  }
  return out;
}

/**
 * When Admin hasn't saved a floor JSON yet, `FloorCanvas` synthesises
 * `T1…TN` from Settings → Table Areas → default count. The reservation
 * modal must use the same fallback — otherwise the floor shows tables
 * while Area → Table dropdown is empty (especially common on secondary
 * areas like Terrace).
 */
function syntheticLabelsFromAreaDefaultCount(
  defaultTableCount: number,
): string[] {
  const raw = Number(defaultTableCount);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
  const capped = Math.max(1, Math.min(200, n));
  return Array.from({ length: capped }, (_, i) => `T${i + 1}`);
}

function sortNaturalTableLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => {
    const an = Number((a.match(/\d+/) || ['0'])[0]);
    const bn = Number((b.match(/\d+/) || ['0'])[0]);
    if (an !== bn) return an - bn;
    return a.localeCompare(b);
  });
}

function toDateInputValue(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export default function ReservationsLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isListView = /\/list\/?$/.test(location.pathname);
  const me = useReservationSessionStore((s) => s.user);
  const setUser = useReservationSessionStore((s) => s.setUser);

  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const [area, setArea] = useState<string>('');
  const [date, setDateState] = useState<Date>(() =>
    startOfLocalDay(new Date()),
  );

  // Centralised modal state — buttons live in the header so every page
  // gets the same call-to-action without duplicating the editor wiring.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] =
    useState<Partial<ReservationDTO> | null>(null);
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInTableLabel, setWalkInTableLabel] = useState<
    string | undefined
  >();
  const [listFiltersOpen, setListFiltersOpen] = useState(false);
  const [listFiltersActive, setListFiltersActive] = useState(false);

  useEffect(() => {
    if (isListView) return;
    setListFiltersOpen(false);
    setListFiltersActive(false);
  }, [isListView]);

  // Shared lookup tables — fetched once here and reused by both pages.
  const [tableLabels, setTableLabels] = useState<string[]>([]);
  const [todayReservations, setTodayReservations] = useState<ReservationDTO[]>(
    [],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  const setDate = useCallback(
    (d: Date) => setDateState(startOfLocalDay(d)),
    [],
  );
  const goRelativeDays = useCallback(
    (delta: number) =>
      setDateState((cur) =>
        startOfLocalDay(new Date(cur.getTime() + delta * 24 * 60 * 60 * 1000)),
      ),
    [],
  );

  const openEditor = useCallback((initial?: Partial<ReservationDTO> | null) => {
    setEditorInitial(initial ?? null);
    setEditorOpen(true);
  }, []);
  const openWalkIn = useCallback((opts?: { tableLabel?: string }) => {
    setWalkInTableLabel(opts?.tableLabel || undefined);
    setWalkInOpen(true);
  }, []);

  const notifyReservationsChanged = useCallback(
    (
      kind: ReservationsChangedKind,
      dateIso?: string | null,
      areaName?: string | null,
    ) => {
      dispatchReservationsChanged({
        kind,
        dateIso: dateIso ?? date.toISOString(),
        area: areaName ?? area ?? null,
      });
    },
    [date, area],
  );

  /** Table labels for `areaName`: saved layout nodes, else same synthetic T1…N as FloorCanvas. */
  const loadLayoutTableLabels = useCallback(
    async (areaName: string): Promise<string[]> => {
      if (!me?.id || !areaName) return [];
      const saved = await (window as any).api.layout
        .get(me.id, areaName, HOST_LAYOUT_SCOPE)
        .catch(() => null);
      const fromSaved = labelsFromLayoutNodes(
        Array.isArray(saved) ? saved : null,
      );
      if (fromSaved.length) return sortNaturalTableLabels(fromSaved);

      const meta = areas.find((a) => String(a.name) === String(areaName));
      const count =
        meta && Number(meta.count) > 0 && Number.isFinite(Number(meta.count))
          ? Number(meta.count)
          : 8;
      return sortNaturalTableLabels(syntheticLabelsFromAreaDefaultCount(count));
    },
    [me?.id, areas],
  );

  // Bootstrapping: load areas from the POS host, not a hardcoded list.
  // Re-run when the tablet comes back to the foreground so an admin
  // rename on the till shows up here without a full app restart.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s: any = await window.api.settings.get();
        if (cancelled) return;
        const sane = saneTableAreas(s?.tableAreas);
        setAreas(sane);
        setArea((current) => pickConfiguredArea(current, sane));
      } catch {
        // ignore — area selector simply stays empty until tables are configured
      }
    };
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Pull table labels for the current header area (floor / walk-in).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!area) {
        setTableLabels([]);
        return;
      }
      const labels = await loadLayoutTableLabels(area);
      if (cancelled) return;
      setTableLabels(labels);
    };
    void load();
    // Re-pull whenever the admin-shared layout changes for this area, so
    // the walk-in dialog never offers a deleted table.
    const onLayout = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as { area?: string };
        if (!detail.area || !area || detail.area !== area) return;
        void load();
      } catch {
        void load();
      }
    };
    window.addEventListener('pos:layoutChanged', onLayout);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:layoutChanged', onLayout);
    };
  }, [area, loadLayoutTableLabels]);

  // Fetch today's reservations for the active area: walk-in free tables +
  // the time-up prompt (seated stays that have run out).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!area) {
        setTodayReservations([]);
        return;
      }
      try {
        const list = await window.api.reservations.list({
          dateIso: startOfLocalDay(new Date()).toISOString(),
          area,
        });
        if (cancelled) return;
        setTodayReservations(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setTodayReservations([]);
      }
    };
    void load();
    const onChanged = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as {
          dateIso?: string;
          area?: string | null;
        };
        if (detail.dateIso) {
          const a = new Date(detail.dateIso);
          const today = startOfLocalDay(new Date());
          const same =
            a.getFullYear() === today.getFullYear() &&
            a.getMonth() === today.getMonth() &&
            a.getDate() === today.getDate();
          if (!same) return;
        }
        if (detail.area && area && String(detail.area) !== String(area)) return;
        void load();
      } catch {
        void load();
      }
    };
    window.addEventListener('pos:reservationsChanged', onChanged);
    const tick = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.removeEventListener('pos:reservationsChanged', onChanged);
    };
  }, [area]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const busyLabels = useMemo(() => {
    const busy = new Set<string>();
    for (const r of todayReservations) {
      if (!r.tableLabel) continue;
      if (reservationOccupiesTable(r, nowMs)) busy.add(r.tableLabel);
    }
    return busy;
  }, [todayReservations, nowMs]);

  const overdueSeated = useMemo(() => {
    return todayReservations
      .filter(
        (r) =>
          Boolean(r.tableLabel) &&
          r.status === 'SEATED' &&
          reservationStayElapsed(r, nowMs),
      )
      .sort((a, b) => {
        const aStart = reservationOccupancyStartMs(a);
        const bStart = reservationOccupancyStartMs(b);
        const aEnd =
          aStart != null
            ? reservationEndMs(new Date(aStart), a.durationMin)
            : null;
        const bEnd =
          bStart != null
            ? reservationEndMs(new Date(bStart), b.durationMin)
            : null;
        return (aEnd ?? 0) - (bEnd ?? 0) || a.id - b.id;
      });
  }, [todayReservations, nowMs]);
  const timeUpReservation = overdueSeated[0] ?? null;

  const freeTableLabels = useMemo(
    () => tableLabels.filter((l) => !busyLabels.has(l)),
    [tableLabels, busyLabels],
  );

  const ctx = useMemo<ReservationsContext>(
    () => ({
      me: me as any,
      area,
      setArea,
      areas,
      date,
      setDate,
      goRelativeDays,
      tableLabels,
      freeTableLabels,
      openEditor,
      openWalkIn,
      notifyReservationsChanged,
      listFiltersOpen,
      setListFiltersOpen,
      listFiltersActive,
      setListFiltersActive,
    }),
    [
      me,
      area,
      areas,
      date,
      setDate,
      goRelativeDays,
      tableLabels,
      freeTableLabels,
      openEditor,
      openWalkIn,
      notifyReservationsChanged,
      listFiltersOpen,
      setListFiltersOpen,
      listFiltersActive,
      setListFiltersActive,
    ],
  );

  function signOut() {
    setUser(null);
    navigate('/reservations', { replace: true });
  }

  return (
    <div
      className="min-h-dvh flex flex-col bg-gray-900 text-gray-100"
      style={{
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Top bar:
          - phones: title + sign-out on row 1, full-width nav on row 2
          - tablet/desktop: classic 3-column grid */}
      <header
        // Same approach as the staff AppLayout: own the safe-area-top
        // inset so the header clears the iPhone status bar / notch
        // without ever exposing the black native view background.
        className="bg-gray-800 pb-2.5 sm:pb-3 pt-[max(0.625rem,env(safe-area-inset-top))] sm:pt-[max(0.75rem,env(safe-area-inset-top))] safe-x flex flex-col gap-2 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-2 sm:items-center"
      >
        <div className="flex items-center justify-between gap-3 min-w-0 sm:justify-start">
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-semibold whitespace-nowrap">
              {t('reservations.title')}
            </div>
            <div className="opacity-70 text-xs truncate hidden xs:block sm:block">
              {me?.displayName} ({String(me?.role || '').toUpperCase()})
            </div>
          </div>
          <button
            type="button"
            className="sm:hidden pos-signout-btn"
            onClick={signOut}
            title={t('reservations.signOut')}
          >
            {t('reservations.signOut')}
          </button>
        </div>

        <nav className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-center sm:gap-2">
          <NavLink
            to="/reservations/app"
            end
            className={({ isActive }) =>
              `pos-nav-link justify-center ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'} w-full`
            }
          >
            {t('reservations.floor')}
          </NavLink>
          <NavLink
            to="/reservations/app/list"
            className={({ isActive }) =>
              `pos-nav-link justify-center ${isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle'} w-full`
            }
          >
            {t('reservations.list')}
          </NavLink>
        </nav>

        <div className="hidden sm:flex items-center gap-2 justify-end">
          <button
            type="button"
            className="hidden sm:inline-flex pos-signout-btn"
            onClick={signOut}
            title={t('reservations.signOut')}
          >
            {t('reservations.signOut')}
          </button>
        </div>
      </header>

      {/* Day / area / actions bar.
          On phones the buttons drop to their own full-width row at the
          bottom so they're easy to tap; on desktop everything sits inline. */}
      <div className="border-b border-gray-700 bg-gray-800 py-2 safe-x flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap sm:gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => goRelativeDays(-1)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-700 bg-gray-900 text-lg leading-none text-gray-100 transition-colors hover:bg-gray-700"
            title={t('reservations.previousDay')}
            aria-label={t('reservations.previousDay')}
          >
            ‹
          </button>
          <input
            type="date"
            value={toDateInputValue(date)}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              const [y, m, d] = v.split('-').map(Number);
              setDate(new Date(y, m - 1, d));
            }}
            // 16px font-size avoids the auto-zoom Safari triggers on smaller text.
            className="cursor-pointer rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-base hover:bg-gray-700 sm:text-sm"
          />
          <button
            type="button"
            onClick={() => goRelativeDays(1)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-700 bg-gray-900 text-lg leading-none text-gray-100 transition-colors hover:bg-gray-700"
            title={t('reservations.nextDay')}
            aria-label={t('reservations.nextDay')}
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => setDate(new Date())}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm transition-colors hover:bg-gray-700 sm:py-1.5"
          >
            {t('reservations.today')}
          </button>
          {isListView && (
            <button
              type="button"
              onClick={() => setListFiltersOpen(true)}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors sm:py-1.5 ${
                listFiltersActive
                  ? 'border-blue-500 bg-blue-700 hover:bg-blue-600'
                  : 'border-gray-700 bg-gray-800 hover:bg-gray-700'
              }`}
              title={t('reservations.filtersTitle')}
            >
              {t('reservations.filters')}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 min-w-0 sm:ml-2">
          <span className="text-xs opacity-70 hidden sm:inline">
            {t('reservations.area')}
          </span>
          <select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-base hover:bg-gray-700 sm:flex-initial sm:py-1.5 sm:text-sm"
          >
            {areas.length === 0 && (
              <option value="">{t('reservations.noAreas')}</option>
            )}
            {areas.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        {/* Action buttons. Pushed to the far right on desktop with `sm:ml-auto`;
            on phones they drop to their own full-width 2-column row so each
            button is comfortable to tap. */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-2 sm:ml-auto">
          <button
            type="button"
            className="px-3 py-2 sm:py-1.5 rounded bg-rose-700 hover:bg-rose-600 text-sm font-medium disabled:opacity-60"
            onClick={() => openWalkIn()}
            disabled={!area || !me?.id}
            title={t('reservations.seatNowTitle')}
          >
            {t('reservations.seatNow')}
          </button>
          <button
            type="button"
            className="px-3 py-2 sm:py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm"
            onClick={() => openEditor({ area })}
            disabled={!me?.id}
            title={t('reservations.newReservationTitle')}
          >
            {t('reservations.newReservation')}
          </button>
        </div>
      </div>

      <main className="flex flex-1 flex-col min-h-0 p-3 sm:p-4">
        <Outlet context={ctx} />
      </main>

      {me?.id && (
        <WalkInDialog
          open={walkInOpen}
          onClose={() => {
            setWalkInOpen(false);
            setWalkInTableLabel(undefined);
          }}
          area={area}
          actorId={me.id}
          tableLabels={tableLabels}
          freeTableLabels={freeTableLabels}
          initialTableLabel={walkInTableLabel}
          // Refresh the local pages immediately. The service broadcasts the
          // same event to every other client via SSE/IPC — we just don't
          // wait on that round-trip for the device that made the change,
          // because EventSource can be silently down (Android background
          // kill, transient Wi-Fi blip, etc.).
          onSeated={(r) =>
            notifyReservationsChanged('created', r.startsAt, r.area)
          }
        />
      )}

      {me?.id && (
        <ReservationEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          initial={editorInitial}
          defaultArea={area}
          areas={areas}
          getTableLabelsForArea={loadLayoutTableLabels}
          actorId={me.id}
          onSaved={(r) =>
            notifyReservationsChanged('updated', r.startsAt, r.area)
          }
          onDeleted={() => notifyReservationsChanged('deleted')}
        />
      )}

      {me?.id && timeUpReservation && (
        <ReservationTimeUpDialog
          reservation={timeUpReservation}
          queueCount={overdueSeated.length}
          actorId={me.id}
          onResolved={(_kind, row) => {
            setTodayReservations((prev) =>
              prev.map((r) => (r.id === row.id ? row : r)),
            );
            notifyReservationsChanged('status', row.startsAt, row.area);
          }}
        />
      )}
    </div>
  );
}
