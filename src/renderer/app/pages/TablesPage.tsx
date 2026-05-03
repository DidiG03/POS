import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/session';
import { useOrderContext } from '@shared/stores/orderContext';
import { useNavigate } from 'react-router-dom';
import { useTableStatus } from '../../stores/tableStatus';
import { useTicketStore } from '../../stores/ticket';
import { formatMoneyCompact } from '../../utils/format';
import { PageSpinner } from '../../components/PageSpinner';

type TableStatus = 'FREE' | 'OCCUPIED' | 'RESERVED' | 'SERVED';
type TableNode = {
  id: number;
  kind?: 'TABLE';
  label: string;
  x: number;
  y: number;
  status: TableStatus;
};
type AreaNode = {
  id: number;
  kind: 'AREA';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
type LayoutNode = TableNode | AreaNode;
type ViewMode = 'occupied' | 'covers' | 'revenue' | 'time';

const GREEN = 'bg-emerald-700';
const RED = 'bg-rose-700';
const ORANGE = 'bg-amber-700';

function isAreaNode(n: LayoutNode): n is AreaNode {
  return (n as any)?.kind === 'AREA';
}
function isTableNode(n: LayoutNode): n is TableNode {
  return !isAreaNode(n);
}

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0)
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function toInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] || '';
  const second = parts[1]?.[0] || '';
  return (first + second).toUpperCase();
}

function generateDefaultNodes(_areaName: string, count: number): TableNode[] {
  const width = 760;
  const height = 460;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) - 60;
  const n = Math.max(0, count);
  return Array.from({ length: n }).map((_, i) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    return { id: i + 1, label: `T${i + 1}`, x, y, status: 'FREE' } as TableNode;
  });
}

function nextAreaId(cur: LayoutNode[] | null): number {
  const ids = (cur || []).map((n) => n.id);
  const min = ids.length ? Math.min(...ids) : 0;
  return min <= 0 ? min - 1 : -1;
}

export default function TablesPage() {
  const [area, setArea] = useState<string>('Main Hall');
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const { user } = useSessionStore();
  const [editable, setEditable] = useState(false);
  const [nodes, setNodes] = useState<LayoutNode[] | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('occupied');
  const [currency, setCurrency] = useState<string>('EUR');
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const { setSelectedTable, pendingAction, setPendingAction } =
    useOrderContext();
  const navigate = useNavigate();

  // Pull stable selectors from zustand — avoid subscribing to the whole store
  const openMap = useTableStatus((s) => s.openMap);
  const setAll = useTableStatus((s) => s.setAll);
  const setOpen = useTableStatus((s) => s.setOpen);

  // Stable snapshot key derived from openMap — only changes when actual keys change.
  // This prevents effects from re-firing when the poll returns the same data.
  const openMapKey = useMemo(() => {
    const keys = Object.keys(openMap)
      .filter((k) => openMap[k])
      .sort();
    return keys.join(',');
  }, [openMap]);

  const isOpenFn = useCallback(
    (a: string, label: string) => Boolean(openMap[`${a}:${label}`]),
    [openMap],
  );

  const [openLoaded, setOpenLoaded] = useState(false);
  const [openLoadError, setOpenLoadError] = useState<string | null>(null);

  useEffect(() => {
    (window as any).__tableStatusStore__ = { setOpen };
    return () => {
      (window as any).__tableStatusStore__ = null;
    };
  }, [setOpen]);

  const { hydrate, clear } = useTicketStore();

  const [userMap, setUserMap] = useState<Record<number, string>>({});
  const [initialsByTable, setInitialsByTable] = useState<
    Record<string, string>
  >({});
  const [ownerByTable, setOwnerByTable] = useState<Record<string, number>>({});
  const [metricsByTable, setMetricsByTable] = useState<
    Record<string, { covers: number | null; total: number }>
  >({});
  const [openedAtByTable, setOpenedAtByTable] = useState<
    Record<string, string>
  >({});
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Load users + settings once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [users, s] = await Promise.all([
          window.api.auth.listUsers(),
          window.api.settings.get(),
        ]);
        if (cancelled) return;
        const map: Record<number, string> = {};
        for (const u of users) map[u.id] = u.displayName;
        setUserMap(map);
        setCurrency(
          String((s as any)?.currency || 'EUR')
            .trim()
            .toUpperCase() || 'EUR',
        );
        setAreas(
          s.tableAreas ?? [
            { name: 'Main Hall', count: s.tableCountMainHall ?? 8 },
            { name: 'Terrace', count: s.tableCountTerrace ?? 4 },
          ],
        );
        if (!s.tableAreas && area !== 'Main Hall' && area !== 'Terrace')
          setArea('Main Hall');
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll open tables from server
  const pollGenRef = useRef(0);
  useEffect(() => {
    const gen = ++pollGenRef.current;
    setOpenLoaded(false);
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const fetchOnce = async () => {
      try {
        if (isHidden()) {
          if (!cancelled && gen === pollGenRef.current) setOpenLoaded(true);
          return;
        }
        const open = await window.api.tables.listOpen();
        if (cancelled || gen !== pollGenRef.current) return;
        if (Array.isArray(open)) setAll(open);
        setOpenLoaded(true);
        setOpenLoadError(null);
      } catch {
        if (!cancelled && gen === pollGenRef.current) {
          setOpenLoaded(true);
          setOpenLoadError(
            'Loading occupied tables… (slow/offline network). Retrying…',
          );
        }
      }
    };

    const poll = async () => {
      try {
        if (!isHidden()) {
          const open = await window.api.tables.listOpen();
          if (cancelled || gen !== pollGenRef.current) return;
          if (Array.isArray(open)) setAll(open);
        }
      } catch {
        // ignore poll errors
      } finally {
        if (!cancelled && gen === pollGenRef.current) {
          timer = setTimeout(poll, isHidden() ? 12000 : 4000);
        }
      }
    };

    fetchOnce().then(() => {
      if (!cancelled && gen === pollGenRef.current) {
        timer = setTimeout(poll, 4000);
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setAll]);

  // Load layout when area changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user || !areas.length) return;
      const cfg = areas.find((a) => a.name === area);
      const targetCount = cfg?.count ?? 8;
      const saved = await window.api.layout.get(user.id, area);
      if (cancelled) return;
      if (Array.isArray(saved)) {
        const savedAny = saved as any[];
        const tables = savedAny.filter((n) => !n?.kind || n.kind === 'TABLE');
        const areasSaved = savedAny.filter((n) => n?.kind === 'AREA');
        if (tables.length === targetCount) {
          const normalizedTables = tables.map((n: any, i: number) => {
            const match = String(n.label).match(/^(?:[^0-9]*)(\d+)$/);
            const num = match ? Number(match[1]) : i + 1;
            return { ...n, kind: 'TABLE', label: `T${num}` } as TableNode;
          });
          const normalizedAreas = areasSaved.map((a: any, idx: number) => ({
            id: Number(a?.id) || -(idx + 1),
            kind: 'AREA' as const,
            label: String(a?.label || 'Area'),
            x: Number(a?.x || 160),
            y: Number(a?.y || 160),
            w: Math.max(80, Number(a?.w || 260)),
            h: Math.max(80, Number(a?.h || 160)),
          })) as AreaNode[];
          setNodes([...(normalizedAreas as any), ...(normalizedTables as any)]);
          return;
        }
      }
      if (!cancelled) setNodes(generateDefaultNodes(area, targetCount));
    })();
    return () => {
      cancelled = true;
    };
  }, [user, area, areas]);

  // Compute which labels are open in the current area (stable via openMapKey)
  const openLabelsInArea = useMemo(() => {
    if (!nodes) return [] as string[];
    return nodes
      .filter(isTableNode)
      .filter((n) => isOpenFn(area, n.label))
      .map((n) => n.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, area, openMapKey]);

  // Load ticket owners for open tables — only re-runs when the set of open labels changes
  useEffect(() => {
    if (!openLoaded || !nodes || !area) return;
    let cancelled = false;
    const labels = openLabelsInArea;

    (async () => {
      const badgeUpdates: [string, string][] = [];
      const ownerUpdates: [string, number][] = [];
      await Promise.all(
        labels.map(async (label) => {
          const k = `${area}:${label}`;
          try {
            const data = await window.api.tickets.getLatestForTable(
              area,
              label,
            );
            if (cancelled) return;
            if (data?.userId) ownerUpdates.push([k, data.userId]);
            if (data?.userId && userMap[data.userId])
              badgeUpdates.push([k, toInitials(userMap[data.userId])]);
          } catch {
            // ignore
          }
        }),
      );
      if (cancelled) return;
      setInitialsByTable((prev) => {
        const next: Record<string, string> = {};
        for (const [key, val] of Object.entries(prev)) {
          if (!key.startsWith(`${area}:`)) next[key] = val;
        }
        for (const [k, v] of badgeUpdates) next[k] = v;
        return next;
      });
      setOwnerByTable((prev) => {
        const next: Record<string, number> = {};
        for (const [key, val] of Object.entries(prev)) {
          if (!key.startsWith(`${area}:`)) next[key] = val as number;
        }
        for (const [k, v] of ownerUpdates) next[k] = v;
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [openLoaded, area, openLabelsInArea, userMap]);

  // Covers/Revenue metrics — only when that view mode is active
  useEffect(() => {
    if (!openLoaded || !nodes || !area) return;
    if (viewMode !== 'covers' && viewMode !== 'revenue') return;
    let cancelled = false;
    const labels = openLabelsInArea;

    const load = async () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
      if (!labels.length) {
        setMetricsByTable((prev) => {
          const next: Record<string, { covers: number | null; total: number }> =
            {};
          for (const [k, v] of Object.entries(prev))
            if (!k.startsWith(`${area}:`)) next[k] = v;
          return next;
        });
        return;
      }

      const updates: Array<[string, { covers: number | null; total: number }]> =
        [];
      const queue = [...labels];
      const concurrency = Math.min(6, queue.length);
      const workers = Array.from({ length: concurrency }).map(async () => {
        while (queue.length && !cancelled) {
          const label = queue.shift()!;
          try {
            const [last, covers] = await Promise.all([
              (window as any).api.tickets
                .getLatestForTable(area, label)
                .catch(() => null),
              (window as any).api.covers.getLast(area, label).catch(() => null),
            ]);
            const items = Array.isArray(last?.items) ? last.items : [];
            const total = items
              .filter((it: any) => !it?.voided)
              .reduce(
                (s: number, it: any) =>
                  s + Number(it?.unitPrice || 0) * Number(it?.qty || 1),
                0,
              );
            const cov = covers ?? last?.covers ?? null;
            updates.push([
              `${area}:${label}`,
              { covers: cov, total: Number(total || 0) },
            ]);
          } catch {
            // ignore
          }
        }
      });
      await Promise.all(workers);
      if (cancelled) return;

      setMetricsByTable((prev) => {
        const next: Record<string, { covers: number | null; total: number }> = {
          ...prev,
        };
        for (const [k, v] of updates) next[k] = v;
        for (const k of Object.keys(next)) {
          if (!k.startsWith(`${area}:`)) continue;
          const l = k.split(':').slice(1).join(':');
          if (!labels.includes(l)) delete next[k];
        }
        return next;
      });
    };

    void load();
    const t = window.setInterval(load, 12000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [openLoaded, area, viewMode, openLabelsInArea]);

  // Time mode: fetch "opened at" per open table
  useEffect(() => {
    if (!openLoaded || !nodes || !area) return;
    if (viewMode !== 'time') return;
    let cancelled = false;
    const labels = openLabelsInArea;

    const load = async () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
      if (!labels.length) {
        setOpenedAtByTable((prev) => {
          const next: Record<string, string> = {};
          for (const [k, v] of Object.entries(prev))
            if (!k.startsWith(`${area}:`)) next[k] = v;
          return next;
        });
        return;
      }

      const updates: Array<[string, string]> = [];
      const queue = [...labels];
      const concurrency = Math.min(6, queue.length);
      const workers = Array.from({ length: concurrency }).map(async () => {
        while (queue.length && !cancelled) {
          const label = queue.shift()!;
          try {
            const tip = await (window as any).api.tickets
              .getTableTooltip(area, label)
              .catch(() => null);
            const iso = String((tip as any)?.firstAt || '');
            if (iso) updates.push([`${area}:${label}`, iso]);
          } catch {
            // ignore
          }
        }
      });
      await Promise.all(workers);
      if (cancelled) return;

      setOpenedAtByTable((prev) => {
        const next: Record<string, string> = { ...prev };
        for (const [k, v] of updates) next[k] = v;
        for (const k of Object.keys(next)) {
          if (!k.startsWith(`${area}:`)) continue;
          const l = k.split(':').slice(1).join(':');
          if (!labels.includes(l)) delete next[k];
        }
        return next;
      });
    };

    void load();
    const t = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [openLoaded, area, viewMode, openLabelsInArea]);

  // Clock tick for time mode — only active when there are open tables to show
  useEffect(() => {
    if (viewMode !== 'time') return;
    if (!openLabelsInArea.length) return;
    const t = window.setInterval(() => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(t);
  }, [viewMode, openLabelsInArea.length]);

  const formatMoney = useCallback(
    (n: number) => formatMoneyCompact(currency, n),
    [currency],
  );

  // Track canvas size for auto-fit
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let cancelled = false;
    const setup = () => {
      if (cancelled) return;
      const el = canvasRef.current;
      if (!el) {
        window.requestAnimationFrame(setup);
        return;
      }
      const update = () => {
        const r = el.getBoundingClientRect();
        setCanvasSize({
          w: Math.max(0, Math.floor(r.width)),
          h: Math.max(0, Math.floor(r.height)),
        });
      };
      update();
      ro = new ResizeObserver(() => update());
      ro.observe(el);
    };
    setup();
    return () => {
      cancelled = true;
      try {
        ro?.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const worldSize = useMemo(() => {
    const cur = nodes || [];
    const TABLE_R = 40;
    let maxX = 760;
    let maxY = 520;
    for (const n of cur as any[]) {
      if (!n) continue;
      if (String(n.kind || 'TABLE') === 'AREA') {
        maxX = Math.max(maxX, Number(n.x || 0) + Math.max(0, Number(n.w || 0)) + 80);
        maxY = Math.max(maxY, Number(n.y || 0) + Math.max(0, Number(n.h || 0)) + 80);
      } else {
        maxX = Math.max(maxX, Number(n.x || 0) + TABLE_R + 80);
        maxY = Math.max(maxY, Number(n.y || 0) + TABLE_R + 80);
      }
    }
    return {
      w: Math.max(760, Math.floor(maxX), editable ? 0 : canvasSize.w),
      h: Math.max(520, Math.floor(maxY), editable ? 0 : canvasSize.h),
    };
  }, [nodes, editable, canvasSize.w, canvasSize.h]);

  const viewTransform = useMemo(() => {
    if (editable) return { scale: 1, tx: 0, ty: 0 };
    const cur = nodes || [];
    if (!cur.length) return { scale: 1, tx: 0, ty: 0 };
    const pad = 48;
    const cw = Math.max(0, canvasSize.w);
    const ch = Math.max(0, canvasSize.h);
    if (cw < 200 || ch < 200) return { scale: 1, tx: 0, ty: 0 };

    const tableHalf = 32;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of cur as any[]) {
      if (!n) continue;
      if (String(n.kind || 'TABLE') === 'AREA') {
        const x = Number(n.x || 0);
        const y = Number(n.y || 0);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + Math.max(0, Number(n.w || 0)));
        maxY = Math.max(maxY, y + Math.max(0, Number(n.h || 0)));
      } else {
        const x = Number(n.x || 0);
        const y = Number(n.y || 0);
        minX = Math.min(minX, x - tableHalf);
        minY = Math.min(minY, y - tableHalf);
        maxX = Math.max(maxX, x + tableHalf);
        maxY = Math.max(maxY, y + tableHalf);
      }
    }
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    )
      return { scale: 1, tx: 0, ty: 0 };
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);

    const maxScale = 1.6;
    const scale = Math.max(
      1,
      Math.min(maxScale, (cw - pad * 2) / bw, (ch - pad * 2) / bh),
    );
    const tx = (cw - bw * scale) / 2 - minX * scale;
    const ty = (ch - bh * scale) / 2 - minY * scale;
    return { scale, tx, ty };
  }, [editable, nodes, canvasSize.w, canvasSize.h]);

  // Stable callbacks for node mutation (used by AreaRect / DraggableCircle)
  const handleNodeMove = useCallback(
    (id: number, x: number, y: number) =>
      setNodes(
        (prev) =>
          prev?.map((n) => (n.id === id ? { ...(n as any), x, y } : n)) ?? prev,
      ),
    [],
  );
  const handleNodeResize = useCallback(
    (id: number, w: number, h: number) =>
      setNodes(
        (prev) =>
          prev?.map((n) => (n.id === id ? { ...(n as any), w, h } : n)) ?? prev,
      ),
    [],
  );
  const handleNodeRename = useCallback(
    (id: number, label: string) =>
      setNodes(
        (prev) =>
          prev?.map((n) =>
            n.id === id ? { ...(n as any), label } : n,
          ) ?? prev,
      ),
    [],
  );
  const handleNodeDelete = useCallback(
    (id: number) =>
      setNodes((prev) => prev?.filter((n) => n.id !== id) ?? prev),
    [],
  );
  const handleTableClick = useCallback(
    (t: TableNode) => {
      if (editable) return;
      setSelectedTable({ id: t.id, label: t.label, area });
      const action = pendingAction;
      if (action) setPendingAction(null);
      if (isOpenFn(area, t.label)) {
        (async () => {
          const data = await window.api.tickets.getLatestForTable(area, t.label);
          if (data) hydrate({ items: data.items as any, note: data.note || '' });
          else clear(); // No TicketLog (opened with covers, no items) — show empty
          navigate('/app/order');
        })();
        return;
      }
      clear();
      navigate('/app/order');
    },
    [
      editable,
      area,
      pendingAction,
      setPendingAction,
      setSelectedTable,
      isOpenFn,
      hydrate,
      clear,
      navigate,
    ],
  );

  if (!openLoaded) {
    return <PageSpinner message={openLoadError || 'Loading tables…'} />;
  }

  // Layout editing is a back-office task; hide it on mobile / browser
  // shells. Admins on the Electron desktop still see it.
  const isBrowserClient =
    typeof window !== 'undefined' &&
    Boolean((window as any).__BROWSER_CLIENT__);
  const canEditLayout = !isBrowserClient;

  return (
    <div className="h-full flex flex-col gap-2 sm:gap-3 min-h-0 overflow-hidden">
      {/* Top bar: title + area pills. On mobile, the H2 is hidden because
          the active area pill already shows context, and we keep all actions
          in a single horizontally-scrollable row. */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="hidden sm:block text-lg font-semibold whitespace-nowrap">
          Tables – {area}
        </h2>
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 sm:mx-0 sm:px-0 flex-1 sm:flex-initial">
          {areas.map((a) => (
            <button
              key={a.name}
              className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap min-h-0 transition-colors ${
                area === a.name
                  ? 'bg-emerald-700 text-white'
                  : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
              }`}
              onClick={() => setArea(a.name)}
            >
              {a.name}
            </button>
          ))}
        </div>
        {canEditLayout && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              className={`px-3 py-1.5 rounded text-sm min-h-0 ${editable ? 'bg-amber-700' : 'bg-gray-700'} cursor-pointer`}
              onClick={() => setEditable((v) => !v)}
            >
              {editable ? 'Editing…' : 'Edit layout'}
            </button>
            {editable && (
              <button
                className="px-3 py-1.5 rounded bg-emerald-700 text-sm min-h-0 cursor-pointer"
                onClick={() => {
                  setNodes((prev) => {
                    const cur = prev || [];
                    const rect = canvasRef.current?.getBoundingClientRect();
                    const x = rect ? Math.max(120, rect.width * 0.5) : 240;
                    const y = rect ? Math.max(120, rect.height * 0.4) : 180;
                    const id = nextAreaId(cur);
                    const node: AreaNode = {
                      id,
                      kind: 'AREA',
                      label: 'Area',
                      x,
                      y,
                      w: 260,
                      h: 160,
                    };
                    return [node, ...cur];
                  });
                }}
              >
                + Area
              </button>
            )}
            {editable && (
              <button
                className="px-3 py-1.5 rounded bg-emerald-700 text-sm min-h-0"
                onClick={async () => {
                  if (!user || !nodes) return;
                  await window.api.layout.save(user.id, area, nodes);
                  setEditable(false);
                }}
              >
                Save
              </button>
            )}
          </div>
        )}
      </div>

      <div
        ref={canvasRef}
        className={`w-full flex-1 min-h-0 rounded bg-gray-800 ${editable ? 'overflow-hidden' : 'overflow-auto'}`}
        style={{
          WebkitOverflowScrolling: 'touch',
          touchAction: editable ? ('none' as any) : ('pan-x pan-y' as any),
        }}
      >
        <div
          className="relative"
          style={{ width: worldSize.w, height: worldSize.h }}
        >
          <div
            className="absolute inset-0"
            style={
              editable
                ? undefined
                : {
                    transform: `translate(${viewTransform.tx}px, ${viewTransform.ty}px) scale(${viewTransform.scale})`,
                    transformOrigin: 'top left',
                  }
            }
          >
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundSize: '40px 40px',
                backgroundImage:
                  'linear-gradient(to right, rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.08) 1px, transparent 1px)',
              }}
            />

            {nodes?.filter(isAreaNode).map((a) => (
              <MemoAreaRect
                key={a.id}
                node={a}
                editable={editable}
                onMove={handleNodeMove}
                onResize={handleNodeResize}
                onRename={handleNodeRename}
                onDelete={handleNodeDelete}
              />
            ))}

            {nodes?.filter(isTableNode).map((t) => (
              <MemoDraggableCircle
                key={t.id}
                node={t}
                editable={editable}
                area={area}
                onMove={handleNodeMove}
                onClick={handleTableClick}
                colorClass={(() => {
                  if (!isOpenFn(area, t.label)) return GREEN;
                  const ownerId = ownerByTable[`${area}:${t.label}`];
                  const uid = user?.id;
                  const singleWaiter = Object.keys(userMap).length <= 1;
                  // RED = my table, ORANGE = other waiter's table
                  // When owner unknown (no TicketLog yet) or only 1 waiter: use RED
                  if (
                    singleWaiter ||
                    ownerId == null ||
                    (uid != null && Number(ownerId) === Number(uid))
                  )
                    return RED;
                  return ORANGE;
                })()}
                badge={
                  isOpenFn(area, t.label)
                    ? initialsByTable[`${area}:${t.label}`]
                    : undefined
                }
                ownerName={
                  (ownerByTable[`${area}:${t.label}`] &&
                    userMap[ownerByTable[`${area}:${t.label}`]]) ||
                  undefined
                }
                statusText={isOpenFn(area, t.label) ? 'OPEN' : 'FREE'}
                viewMode={viewMode}
                metricText={(() => {
                  const k = `${area}:${t.label}`;
                  const m = metricsByTable[k];
                  if (!isOpenFn(area, t.label)) return null;
                  if (viewMode === 'covers')
                    return m ? String(m.covers ?? '—') : '…';
                  if (viewMode === 'revenue')
                    return m ? formatMoney(m.total) : '…';
                  if (viewMode === 'time') {
                    const iso = openedAtByTable[k];
                    const ms = iso ? new Date(iso).getTime() : NaN;
                    return Number.isFinite(ms)
                      ? formatElapsed(nowMs - ms)
                      : '…';
                  }
                  return null;
                })()}
              />
            ))}
          </div>

          {area === 'Main Hall' && (
            <div
              className="absolute bottom-6 left-6 right-6 h-4 rounded bg-gray-700 opacity-70"
              title="Bar"
            />
          )}
        </div>
      </div>

      <div className="flex items-stretch sm:items-center justify-center gap-1.5 sm:gap-2 bg-gray-800/80 backdrop-blur rounded-lg p-1.5 sm:p-2 shrink-0">
        <ModeButton
          active={viewMode === 'occupied'}
          onClick={() => setViewMode('occupied')}
          label="Occupied"
        >
          <IconUsers />
        </ModeButton>
        <ModeButton
          active={viewMode === 'covers'}
          onClick={() => setViewMode('covers')}
          label="Covers"
        >
          <IconCovers />
        </ModeButton>
        <ModeButton
          active={viewMode === 'revenue'}
          onClick={() => setViewMode('revenue')}
          label="Revenue"
        >
          <IconMoney />
        </ModeButton>
        <ModeButton
          active={viewMode === 'time'}
          onClick={() => setViewMode('time')}
          label="Time"
        >
          <IconClock />
        </ModeButton>
      </div>
    </div>
  );
}

// --- AreaRect ---

function AreaRect({
  node,
  editable,
  onMove,
  onResize,
  onRename,
  onDelete,
}: {
  node: AreaNode;
  editable: boolean;
  onMove: (id: number, x: number, y: number) => void;
  onResize: (id: number, w: number, h: number) => void;
  onRename: (id: number, label: string) => void;
  onDelete: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const modeRef = useRef<null | 'DRAG' | 'E' | 'S' | 'SE'>(null);
  const startRef = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    px: number;
    py: number;
  } | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(node.label);

  useEffect(() => {
    if (renaming) setDraftLabel(node.label);
  }, [node.label, renaming]);

  useEffect(() => {
    if (!renaming) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [renaming]);

  // Keep DOM in sync imperatively for smooth drag
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.w}px`;
    el.style.height = `${node.h}px`;
  }, [node.x, node.y, node.w, node.h]);

  // Use a ref to always read the latest node without re-attaching listeners
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const el = ref.current;
    if (!el || !editable) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.closest('button') ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA')
      )
        return;
      const h = String((e.target as HTMLElement)?.dataset?.handle || '');
      modeRef.current =
        h === 'e' ? 'E' : h === 's' ? 'S' : h === 'se' ? 'SE' : 'DRAG';
      const n = nodeRef.current;
      startRef.current = {
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        px: e.clientX,
        py: e.clientY,
      };
      (el as any).setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!startRef.current || !modeRef.current) return;
      const dx = e.clientX - startRef.current.px;
      const dy = e.clientY - startRef.current.py;
      const n = nodeRef.current;
      if (modeRef.current === 'DRAG') {
        onMoveRef.current(n.id, startRef.current.x + dx, startRef.current.y + dy);
      } else {
        const addW =
          modeRef.current === 'E' || modeRef.current === 'SE' ? dx : 0;
        const addH =
          modeRef.current === 'S' || modeRef.current === 'SE' ? dy : 0;
        onResizeRef.current(
          n.id,
          Math.max(80, startRef.current.w + addW),
          Math.max(80, startRef.current.h + addH),
        );
      }
      e.preventDefault();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (modeRef.current) suppressClickUntilRef.current = Date.now() + 250;
      modeRef.current = null;
      startRef.current = null;
      try {
        (el as any).releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
    };
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [editable]);

  return (
    <div
      ref={ref}
      className={`absolute -translate-x-1/2 -translate-y-1/2 border-2 border-emerald-500 bg-transparent rounded ${editable ? 'cursor-move' : 'pointer-events-none'} select-none`}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        height: node.h,
        touchAction: 'none' as any,
      }}
      onClick={(e) => {
        if (Date.now() < suppressClickUntilRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDoubleClick={() => {
        if (!editable) return;
        setRenaming(true);
      }}
      title={editable ? 'Double click to rename' : undefined}
    >
      <div className="absolute left-2 top-2 text-xs font-semibold text-emerald-300">
        {renaming ? (
          <input
            ref={inputRef}
            className="bg-gray-900/70 border border-emerald-500 rounded px-2 py-1 text-emerald-100 text-xs w-44"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setRenaming(false);
                setDraftLabel(node.label);
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const next = draftLabel.trim();
                if (next) onRename(node.id, next);
                setRenaming(false);
              }
            }}
            onBlur={() => {
              const next = draftLabel.trim();
              if (next && next !== node.label) onRename(node.id, next);
              setRenaming(false);
            }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          />
        ) : (
          node.label
        )}
      </div>
      {editable && (
        <>
          <button
            type="button"
            className="absolute right-2 top-2 text-xs px-2 py-1 rounded bg-gray-900/60 border border-gray-700 hover:bg-gray-900"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(node.id);
            }}
            title="Delete"
          >
            ✕
          </button>
          <div
            data-handle="e"
            className="absolute top-1/2 -right-1 w-2 h-10 -translate-y-1/2 bg-emerald-500/80 rounded cursor-ew-resize"
          />
          <div
            data-handle="s"
            className="absolute left-1/2 -bottom-1 w-10 h-2 -translate-x-1/2 bg-emerald-500/80 rounded cursor-ns-resize"
          />
          <div
            data-handle="se"
            className="absolute -right-1 -bottom-1 w-3 h-3 bg-emerald-500 rounded cursor-nwse-resize"
          />
        </>
      )}
    </div>
  );
}

const MemoAreaRect = memo(AreaRect);

// --- DraggableCircle ---

function DraggableCircle({
  node,
  editable,
  onMove,
  onClick,
  colorClass,
  badge,
  ownerName,
  statusText,
  area,
  viewMode,
  metricText,
}: {
  node: TableNode;
  editable: boolean;
  onMove: (id: number, x: number, y: number) => void;
  onClick?: (node: TableNode) => void;
  colorClass?: string;
  badge?: string;
  ownerName?: string;
  statusText?: string;
  area?: string;
  viewMode?: ViewMode;
  metricText?: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<{
    covers: number | null;
    firstAt: string | null;
    total: number;
  } | null>(null);
  const [showTip, setShowTip] = useState(false);
  const holdTimer = useRef<any>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({
    x: node.x,
    y: node.y,
  });
  const posRef = useRef<{ x: number; y: number }>({ x: node.x, y: node.y });
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const dragDistanceRef = useRef(0);
  const suppressClickUntilRef = useRef(0);

  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const nodeRef = useRef(node);
  nodeRef.current = node;

  useEffect(() => {
    if (draggingRef.current) return;
    posRef.current = { x: node.x, y: node.y };
    setPos({ x: node.x, y: node.y });
  }, [node.x, node.y]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !editable) return;
    draggingRef.current = false;
    dragDistanceRef.current = 0;
    const onPointerDown = (e: PointerEvent) => {
      draggingRef.current = true;
      dragDistanceRef.current = 0;
      (el as any).setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const parent = el.parentElement!.getBoundingClientRect();
      const relX = e.clientX - parent.left;
      const relY = e.clientY - parent.top;
      const newX = Math.max(16, Math.min(parent.width - 16, relX));
      const newY = Math.max(16, Math.min(parent.height - 16, relY));
      const dx = newX - posRef.current.x;
      const dy = newY - posRef.current.y;
      dragDistanceRef.current += Math.sqrt(dx * dx + dy * dy);
      posRef.current = { x: newX, y: newY };

      if (rafRef.current == null) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null;
          setPos(posRef.current);
        });
      }
      e.preventDefault();
    };
    const onPointerUp = (e: PointerEvent) => {
      const wasDragging = draggingRef.current;
      draggingRef.current = false;
      (el as any).releasePointerCapture?.(e.pointerId);
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (wasDragging) {
        const finalPos = posRef.current;
        setPos(finalPos);
        onMoveRef.current(nodeRef.current.id, finalPos.x, finalPos.y);
        if (dragDistanceRef.current > 6)
          suppressClickUntilRef.current = Date.now() + 300;
      }
      e.preventDefault();
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [editable]);

  // Tooltip: use refs so listeners never need re-attaching
  const areaRef = useRef(area);
  areaRef.current = area;
  const labelRef = useRef(node.label);
  labelRef.current = node.label;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const fetchTip = async () => {
      try {
        if (!areaRef.current) return;
        const t = await (window as any).api.tickets.getTableTooltip(
          areaRef.current,
          labelRef.current,
        );
        if (cancelled) return;
        setTooltip(t);
        setShowTip(true);
      } catch {
        // ignore
      }
    };
    const onEnter = () => {
      holdTimer.current = setTimeout(fetchTip, 500);
    };
    const onLeave = () => {
      clearTimeout(holdTimer.current);
      setShowTip(false);
    };
    const onDown = () => {
      holdTimer.current = setTimeout(fetchTip, 2000);
    };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('touchstart', onDown, { passive: true } as any);
    el.addEventListener('touchend', onLeave, { passive: true } as any);
    return () => {
      cancelled = true;
      clearTimeout(holdTimer.current);
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('touchstart', onDown as any);
      el.removeEventListener('touchend', onLeave as any);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`absolute -translate-x-1/2 -translate-y-1/2 w-16 h-16 ${colorClass || GREEN} rounded-full flex items-center justify-center shadow-lg ${editable ? 'cursor-move' : 'cursor-pointer'} select-none overflow-hidden`}
      style={{
        left: pos.x,
        top: pos.y,
        touchAction: 'none' as any,
        willChange: editable ? ('transform,left,top' as any) : undefined,
      }}
      title={`${node.label} • ${statusText || node.status}`}
      onClick={() => {
        if (Date.now() < suppressClickUntilRef.current) return;
        onClickRef.current?.(nodeRef.current);
      }}
    >
      <div className="flex flex-col items-center leading-none">
        <span className="text-sm font-semibold">{node.label}</span>
        {viewMode === 'occupied' ? (
          <>
            {badge && (
              <span className="mt-0.5 text-[10px] font-semibold px-1 rounded bg-black/40">
                {badge}
              </span>
            )}
            {statusText && (
              <span className="mt-0.5 text-[10px] opacity-90">
                {statusText}
              </span>
            )}
          </>
        ) : (
          metricText && (
            <span className="mt-0.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-black/40 max-w-[56px] text-center leading-[1.05] break-words">
              {viewMode === 'covers' ? `P: ${metricText}` : metricText}
            </span>
          )
        )}
      </div>
      {showTip && tooltip && (
        <div className="absolute top-18 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs bg-black/80 text-white px-2 py-1 rounded shadow">
          {ownerName && <div>{ownerName}</div>}
          <div>Guests: {tooltip.covers ?? '-'}</div>
          <div>
            Since:{' '}
            {tooltip.firstAt
              ? new Date(tooltip.firstAt).toLocaleTimeString()
              : '-'}
          </div>
          <div>
            Total:{' '}
            {tooltip.total.toFixed ? tooltip.total.toFixed(2) : tooltip.total}
          </div>
        </div>
      )}
    </div>
  );
}

const MemoDraggableCircle = memo(DraggableCircle);

// --- Bottom bar icons ---

function ModeButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: any;
}) {
  return (
    <button
      className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 rounded transition-colors min-h-0 ${
        active
          ? 'bg-emerald-600/90 text-white shadow-sm'
          : 'bg-gray-900/40 text-gray-200 hover:bg-gray-700/60'
      }`}
      onClick={onClick}
      title={label}
      type="button"
      aria-pressed={active}
    >
      <span className={active ? 'opacity-100' : 'opacity-80'}>{children}</span>
      <span className="text-xs sm:text-sm">{label}</span>
    </button>
  );
}

function IconUsers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM4 20a7 7 0 0 1 16 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCovers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM2 22a7 7 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20 8a3 3 0 1 0-6 0 3 3 0 0 0 6 0ZM13.5 22a6 6 0 0 1 8.5-5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoney() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 7h10a4 4 0 0 1 0 8H9a3 3 0 0 0 0 6h8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 3v18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 22a10 10 0 1 0-10-10 10 10 0 0 0 10 10Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 6v6l4 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
