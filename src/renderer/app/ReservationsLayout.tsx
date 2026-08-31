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
import { BrandMark } from '../components/BrandMark';
import { Button, Select, cn } from '../components/ui';
import {
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconGrid,
  IconList,
  IconLogout,
  IconPlus,
} from '../components/icons';

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
  /** Tables with an unpaid waiter ticket. Occupied until paid. */
  openTables: { area: string; label: string }[];
  /** Latest waiter payment per table for the selected day. */
  paidTables: { area: string; label: string; paidAt: string }[];
  openEditor: (initial?: Partial<ReservationDTO> | null) => void;
  openWalkIn: (opts?: { tableLabel?: string }) => void;
  /** List view: Sot sits in this layout; Filtrat opens the list filter sheet. */
  listFiltersOpen: boolean;
  setListFiltersOpen: (open: boolean) => void;
  listFiltersActive: boolean;
  setListFiltersActive: (active: boolean) => void;
  /** Floor overlay: paint tables used that day red and show a use-count. */
  showDayOccupancy: boolean;
  setShowDayOccupancy: (on: boolean) => void;
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
  const [showDayOccupancy, setShowDayOccupancy] = useState(false);

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
  const [openTables, setOpenTables] = useState<
    { area: string; label: string }[]
  >([]);
  const [paidTables, setPaidTables] = useState<
    { area: string; label: string; paidAt: string }[]
  >([]);
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

  // Today's reservations (all areas): walk-in free tables, editor occupancy,
  // and the time-up prompt (seated stays that have run out).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await window.api.reservations.list({
          dateIso: startOfLocalDay(new Date()).toISOString(),
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
  }, []);

  const reloadOpenTables = useCallback(async () => {
    try {
      const open = await window.api.tables.listOpen();
      if (Array.isArray(open)) setOpenTables(open);
    } catch {
      // Older tills may not let HOST read open tables.
    }
  }, []);

  const reloadPaidTables = useCallback(async () => {
    try {
      const paid = await window.api.tickets.listPaidTables({
        dateIso: date.toISOString(),
      });
      if (Array.isArray(paid)) setPaidTables(paid);
    } catch {
      // Older tills may not expose paid-table lookup to HOST.
    }
  }, [date]);

  useEffect(() => {
    void reloadOpenTables();
  }, [reloadOpenTables]);

  useEffect(() => {
    void reloadPaidTables();
  }, [reloadPaidTables]);

  useEffect(() => {
    const onChanged = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { area?: string; label?: string; open?: boolean }
        | undefined;
      const a = detail?.area;
      const l = detail?.label;
      const o = detail?.open;
      if (a && l && typeof o === 'boolean') {
        setOpenTables((prev) => {
          const next = prev.filter((t) => !(t.area === a && t.label === l));
          if (o) next.push({ area: a, label: l });
          return next;
        });
      }
      void reloadOpenTables();
      void reloadPaidTables();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void reloadOpenTables();
        void reloadPaidTables();
      }
    };
    window.addEventListener('pos:tablesChanged', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.removeEventListener('pos:tablesChanged', onChanged);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [reloadOpenTables, reloadPaidTables]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const busyLabels = useMemo(() => {
    const busy = new Set<string>();
    for (const r of todayReservations) {
      if (area && r.area !== area) continue;
      if (!r.tableLabel) continue;
      if (reservationOccupiesTable(r, nowMs)) busy.add(r.tableLabel);
    }
    for (const t of openTables) {
      if (area && t.area !== area) continue;
      if (t.label) busy.add(t.label);
    }
    return busy;
  }, [todayReservations, openTables, area, nowMs]);

  const isTableBusy = useCallback(
    (areaName: string, label: string) => {
      const a = String(areaName || '');
      const l = String(label || '');
      if (!a || !l) return false;
      return todayReservations.some(
        (r) =>
          r.area === a &&
          r.tableLabel === l &&
          reservationOccupiesTable(r, nowMs),
      );
    },
    [todayReservations, nowMs],
  );

  const isTableOpenTicket = useCallback(
    (areaName: string, label: string) => {
      const a = String(areaName || '');
      const l = String(label || '');
      if (!a || !l) return false;
      return openTables.some((t) => t.area === a && t.label === l);
    },
    [openTables],
  );

  const overdueSeated = useMemo(() => {
    return todayReservations
      .filter(
        (r) =>
          (!area || r.area === area) &&
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
  }, [todayReservations, nowMs, area]);
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
      openTables,
      paidTables,
      openEditor,
      openWalkIn,
      notifyReservationsChanged,
      listFiltersOpen,
      setListFiltersOpen,
      listFiltersActive,
      setListFiltersActive,
      showDayOccupancy,
      setShowDayOccupancy,
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
      openTables,
      paidTables,
      openEditor,
      openWalkIn,
      notifyReservationsChanged,
      listFiltersOpen,
      setListFiltersOpen,
      listFiltersActive,
      setListFiltersActive,
      showDayOccupancy,
      setShowDayOccupancy,
    ],
  );

  function signOut() {
    setUser(null);
    navigate('/reservations', { replace: true });
  }

  return (
    <div
      className="min-h-dvh flex flex-col pos-app text-gray-100"
      style={{
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Top bar: brand, view switcher, identity. Owns the safe-area-top inset
          like the staff AppLayout so it clears the notch without exposing the
          black native view background. */}
      <header
        className="pos-header safe-x flex shrink-0 items-center gap-3 pt-[max(0px,env(safe-area-inset-top))]"
        style={{ minHeight: 'var(--pos-header-h)' }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BrandMark
            size="sm"
            compact
            subtitle={t('reservations.title')}
            className="hidden sm:flex"
          />
          <BrandMark size="sm" compact wordmark={false} className="sm:hidden" />
        </div>

        <nav className="pos-segmented shrink-0">
          <NavLink
            to="/reservations/app"
            end
            className={({ isActive }) =>
              cn(
                'pos-nav-link',
                isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle',
              )
            }
          >
            <IconGrid />
            <span>{t('reservations.floor')}</span>
          </NavLink>
          <NavLink
            to="/reservations/app/list"
            className={({ isActive }) =>
              cn(
                'pos-nav-link',
                isActive ? 'pos-nav-link--active' : 'pos-nav-link--idle',
              )
            }
          >
            <IconList />
            <span>{t('reservations.list')}</span>
          </NavLink>
        </nav>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <span className="hidden min-w-0 truncate text-[13px] text-gray-400 sm:block">
            {me?.displayName}
          </span>
          <button
            type="button"
            className="pos-icon-btn hover:!bg-rose-500/12 hover:!text-rose-300"
            onClick={signOut}
            title={t('reservations.signOut')}
            aria-label={t('reservations.signOut')}
          >
            <IconLogout />
          </button>
        </div>
      </header>

      {/* Day / area / actions bar. On phones the primary actions drop to their
          own full-width row so they stay comfortable to tap. */}
      <div className="pos-toolbar safe-x flex flex-col gap-2 py-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Grouped stepper: the date and its arrows read as one control. */}
          <div className="flex items-center overflow-hidden rounded-lg border border-white/12 bg-gray-800">
            <button
              type="button"
              onClick={() => goRelativeDays(-1)}
              className="flex items-center justify-center px-2 text-gray-400 transition-colors hover:bg-white/6 hover:text-gray-100"
              style={{ height: 'var(--pos-control-h)', minHeight: 0 }}
              title={t('reservations.previousDay')}
              aria-label={t('reservations.previousDay')}
            >
              <IconChevronLeft />
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
              className="cursor-pointer border-x border-white/12 bg-transparent px-2.5 text-[13px] text-gray-100 tabular focus:outline-none"
              style={{ height: 'var(--pos-control-h)', minHeight: 0 }}
            />
            <button
              type="button"
              onClick={() => goRelativeDays(1)}
              className="flex items-center justify-center px-2 text-gray-400 transition-colors hover:bg-white/6 hover:text-gray-100"
              style={{ height: 'var(--pos-control-h)', minHeight: 0 }}
              title={t('reservations.nextDay')}
              aria-label={t('reservations.nextDay')}
            >
              <IconChevronRight />
            </button>
          </div>
          <Button onClick={() => setDate(new Date())}>
            {t('reservations.today')}
          </Button>
          <Button
            icon={<IconFilter />}
            onClick={() => setListFiltersOpen(true)}
            title={t('reservations.filtersTitle')}
            className={cn(
              (listFiltersActive || showDayOccupancy) &&
                '!border-white/20 !bg-white/10 !text-gray-50',
            )}
          >
            {t('reservations.filters')}
          </Button>
        </div>

        <div className="flex min-w-0 items-center gap-2 sm:ml-1">
          <span className="pos-section-label hidden shrink-0 sm:inline">
            {t('reservations.area')}
          </span>
          <Select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="min-w-0 flex-1 sm:w-40 sm:flex-initial"
          >
            {areas.length === 0 && (
              <option value="">{t('reservations.noAreas')}</option>
            )}
            {areas.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex sm:items-center">
          <Button
            onClick={() => openWalkIn()}
            disabled={!area || !me?.id}
            title={t('reservations.seatNowTitle')}
          >
            {t('reservations.seatNow')}
          </Button>
          <Button
            variant="primary"
            icon={<IconPlus />}
            onClick={() => openEditor({ area })}
            disabled={!me?.id}
            title={t('reservations.newReservationTitle')}
          >
            {t('reservations.newReservation')}
          </Button>
        </div>
      </div>

      <main className="safe-x flex min-h-0 flex-1 flex-col py-3 sm:py-4">
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
          isTableBusy={isTableBusy}
          isTableOpenTicket={isTableOpenTicket}
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
