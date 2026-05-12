import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  useReservationSessionStore,
  HOST_LAYOUT_SCOPE,
} from '../stores/reservationSession';
import ReservationEditor from './components/ReservationEditor';
import WalkInDialog from './components/WalkInDialog';
import type { ReservationDTO } from '@shared/ipc';

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
  openWalkIn: () => void;
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

// Reservations are "live" (occupy a table) only while BOOKED or SEATED.
function isLiveStatus(s: string): boolean {
  return s === 'BOOKED' || s === 'SEATED';
}

export default function ReservationsLayout() {
  const navigate = useNavigate();
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

  // Shared lookup tables — fetched once here and reused by both pages.
  const [tableLabels, setTableLabels] = useState<string[]>([]);
  const [busyLabels, setBusyLabels] = useState<Set<string>>(new Set());

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
  const openWalkIn = useCallback(() => setWalkInOpen(true), []);

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

  // Bootstrapping: load areas from settings.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s: any = await window.api.settings.get();
        if (cancelled) return;
        const list: { name: string; count: number }[] =
          (s?.tableAreas as any) || [];
        const sane = Array.isArray(list) ? list : [];
        setAreas(sane);
        if (!area && sane.length) setArea(String(sane[0].name));
      } catch {
        // ignore — area selector simply stays empty until tables are configured
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only on mount: the area selector is auto-seeded once
    // and the user controls subsequent changes via the dropdown.
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

  // Fetch the day's reservations for the active area to derive which tables
  // are busy. Pages have their own fetches but this one is small and feeds
  // the WalkInDialog's free-table picker.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!area) {
        setBusyLabels(new Set());
        return;
      }
      try {
        const list = await window.api.reservations.list({
          dateIso: date.toISOString(),
          area,
        });
        if (cancelled) return;
        const busy = new Set<string>();
        for (const r of list) {
          if (!r.tableLabel) continue;
          if (isLiveStatus(r.status)) busy.add(r.tableLabel);
        }
        setBusyLabels(busy);
      } catch {
        if (!cancelled) setBusyLabels(new Set());
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
          const same =
            a.getFullYear() === date.getFullYear() &&
            a.getMonth() === date.getMonth() &&
            a.getDate() === date.getDate();
          if (!same) return;
        }
        if (detail.area && area && String(detail.area) !== String(area)) return;
        void load();
      } catch {
        void load();
      }
    };
    window.addEventListener('pos:reservationsChanged', onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('pos:reservationsChanged', onChanged);
    };
  }, [area, date]);

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
    ],
  );

  function signOut() {
    setUser(null);
    navigate('/reservations', { replace: true });
  }

  return (
    <div
      className="min-h-dvh flex flex-col bg-gray-900 text-gray-100"
      // Respect iOS notch / Android system bars when running in Capacitor.
      style={{
        paddingTop: 'env(safe-area-inset-top)',
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
        className="bg-gray-800 px-3 sm:px-4 pb-2 sm:pb-3 pt-[max(0.5rem,env(safe-area-inset-top))] sm:pt-[max(0.75rem,env(safe-area-inset-top))] safe-x flex flex-col gap-2 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-2 sm:items-center"
      >
        <div className="flex items-center justify-between gap-3 min-w-0 sm:justify-start">
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-semibold whitespace-nowrap">Reservations</div>
            <div className="opacity-70 text-xs truncate hidden xs:block sm:block">
              {me?.displayName} ({String(me?.role || '').toUpperCase()})
            </div>
          </div>
          <button
            type="button"
            className="sm:hidden px-3 py-1.5 rounded bg-rose-700 hover:bg-rose-600 text-sm"
            onClick={signOut}
            title="Sign out"
          >
            Sign out
          </button>
        </div>

        <nav className="text-sm grid grid-cols-2 gap-1 sm:flex sm:items-center sm:gap-2 sm:justify-center">
          <NavLink
            to="/reservations/app"
            end
            className={({ isActive }) =>
              `px-3 py-2 sm:py-1.5 rounded text-center ${
                isActive ? 'bg-gray-700/70' : 'hover:bg-gray-700/50'
              }`
            }
          >
            Floor
          </NavLink>
          <NavLink
            to="/reservations/app/list"
            className={({ isActive }) =>
              `px-3 py-2 sm:py-1.5 rounded text-center ${
                isActive ? 'bg-gray-700/70' : 'hover:bg-gray-700/50'
              }`
            }
          >
            List
          </NavLink>
        </nav>

        <div className="hidden sm:flex items-center gap-2 justify-end">
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-rose-700 hover:bg-rose-600 text-sm"
            onClick={signOut}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Day / area / actions bar.
          On phones the buttons drop to their own full-width row at the
          bottom so they're easy to tap; on desktop everything sits inline. */}
      <div className="bg-gray-850 border-b border-gray-700 px-3 sm:px-4 py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap sm:gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => goRelativeDays(-1)}
            className="w-9 h-9 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center text-lg"
            title="Previous day"
            aria-label="Previous day"
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
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-base sm:text-sm cursor-pointer hover:bg-gray-700"
          />
          <button
            type="button"
            onClick={() => goRelativeDays(1)}
            className="w-9 h-9 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center text-lg"
            title="Next day"
            aria-label="Next day"
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => setDate(new Date())}
            className="px-3 py-2 sm:py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm"
          >
            Today
          </button>
        </div>

        <div className="flex items-center gap-2 min-w-0 sm:ml-2">
          <span className="text-xs opacity-70 hidden sm:inline">Area</span>
          <select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 sm:py-1.5 text-base sm:text-sm flex-1 sm:flex-initial sm:max-w-none"
          >
            {areas.length === 0 && <option value="">(no areas)</option>}
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
            onClick={openWalkIn}
            disabled={!area || !me?.id}
            title="Create a SEATED reservation right now"
          >
            Seat now
          </button>
          <button
            type="button"
            className="px-3 py-2 sm:py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-sm"
            onClick={() => openEditor({ area })}
            disabled={!me?.id}
            title="Create a new reservation"
          >
            + New reservation
          </button>
        </div>
      </div>

      <main className="flex flex-1 flex-col min-h-0 p-3 sm:p-4">
        <Outlet context={ctx} />
      </main>

      {me?.id && (
        <WalkInDialog
          open={walkInOpen}
          onClose={() => setWalkInOpen(false)}
          area={area}
          actorId={me.id}
          tableLabels={tableLabels}
          freeTableLabels={freeTableLabels}
          // SSE refreshes both the Floor and List pages automatically — the
          // dialog only needs to close itself, no parent reload.
          onSeated={() => {
            /* no-op: pos:reservationsChanged drives refresh */
          }}
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
          onSaved={() => {
            /* no-op: pos:reservationsChanged drives refresh */
          }}
          onDeleted={() => {
            /* no-op: pos:reservationsChanged drives refresh */
          }}
        />
      )}
    </div>
  );
}
