import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/session';
import { useOrderContext } from '@shared/stores/orderContext';
import { useNavigate } from 'react-router-dom';
import { useTableStatus } from '../../stores/tableStatus';
import { useTicketStore } from '../../stores/ticket';
import { formatMoneyCompact } from '../../utils/format';

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
  const { isOpen, openMap, setAll, setOpen } = useTableStatus();
  const [openLoaded, setOpenLoaded] = useState(false);
  const [openLoadError, setOpenLoadError] = useState<string | null>(null);
  useEffect(() => {
    // Expose setOpen for SSE updates
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

  function formatElapsed(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (hh > 0)
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  useEffect(() => {
    (async () => {
      try {
        const users = await window.api.auth.listUsers();
        const map: Record<number, string> = {};
        for (const u of users) map[u.id] = u.displayName;
        setUserMap(map);
      } catch (e) {
        void e;
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();
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
    })();
  }, []);

  // Cross-client sync: poll open tables from server and update local state
  useEffect(() => {
    let timer: any;
    let cancelled = false;
    const loop = async () => {
      const hidden =
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden';
      try {
        if (hidden) return;
        const open = await window.api.tables.listOpen();
        if (Array.isArray(open)) setAll(open);
        if (!cancelled) {
          setOpenLoaded(true);
          setOpenLoadError(null);
        }
      } catch (e: any) {
        void e;
        if (!cancelled) {
          setOpenLoadError(
            'Loading occupied tables… (slow/offline network). Retrying…',
          );
        }
      } finally {
        // Slow down while hidden to reduce background work.
        timer = setTimeout(loop, hidden ? 12000 : 4000);
      }
    };
    loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [setAll]);

  function generateDefaultNodes(areaName: string, count: number): TableNode[] {
    const width = 760;
    const height = 460;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) - 60;
    // Always use 'T' prefix across all areas so we don't create multiple label schemes
    const baseLabel = 'T';
    const n = Math.max(0, count);
    return Array.from({ length: n }).map((_, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      return {
        id: i + 1,
        label: `${baseLabel}${i + 1}`,
        x,
        y,
        status: 'FREE',
      } as TableNode;
    });
  }

  function isAreaNode(n: LayoutNode): n is AreaNode {
    return (n as any)?.kind === 'AREA';
  }
  function isTableNode(n: LayoutNode): n is TableNode {
    return !isAreaNode(n);
  }
  function nextAreaId(cur: LayoutNode[] | null): number {
    const ids = (cur || []).map((n) => n.id);
    const min = ids.length ? Math.min(...ids) : 0;
    return min <= 0 ? min - 1 : -1; // keep areas negative to avoid collision with table ids
  }

  // Deterministic load: prefer saved layout if it matches area count, else generate once
  useEffect(() => {
    (async () => {
      if (!user || !areas.length) return;
      const cfg = areas.find((a) => a.name === area);
      const targetCount = cfg?.count ?? 8;
      const saved = await window.api.layout.get(user.id, area);
      if (Array.isArray(saved)) {
        const savedAny = saved as any[];
        const tables = savedAny.filter((n) => !n?.kind || n.kind === 'TABLE');
        const areasSaved = savedAny.filter((n) => n?.kind === 'AREA');
        if (tables.length === targetCount) {
          // Normalize any legacy labels like 'M1' -> 'T1' so only one layout scheme exists
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
      setNodes(generateDefaultNodes(area, targetCount));
    })();
  }, [user, area, areas]);

  function toInitials(name: string): string {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const first = parts[0]?.[0] || '';
    const second = parts[1]?.[0] || '';
    return (first + second).toUpperCase();
  }

  // Load latest ticket owners for open tables in current area
  useEffect(() => {
    (async () => {
      if (!openLoaded) return;
      if (!nodes || !area) return;
      const badgeUpdates: [string, string][] = [];
      const ownerUpdates: [string, number][] = [];
      await Promise.all(
        nodes.filter(isTableNode).map(async (n) => {
          if (!isOpen(area, n.label)) return;
          const k = `${area}:${n.label}`;
          try {
            const data = await window.api.tickets.getLatestForTable(
              area,
              n.label,
            );
            if (data?.userId) ownerUpdates.push([k, data.userId]);
            if (data?.userId && userMap[data.userId])
              badgeUpdates.push([k, toInitials(userMap[data.userId])]);
          } catch (e) {
            void e;
          }
        }),
      );
      setInitialsByTable((prev) => {
        const next: Record<string, string> = {};
        // keep badges for other areas, replace current area keys
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
  }, [openLoaded, area, nodes, userMap, openMap]);

  const openLabelsInArea = useMemo(() => {
    if (!nodes) return [];
    return nodes
      .filter(isTableNode)
      .filter((n) => isOpen(area, n.label))
      .map((n) => n.label);
  }, [nodes, area, isOpen, openMap]);

  // Bottom filters: when Covers/Revenue mode is active, prefetch per-table metrics for open tables.
  useEffect(() => {
    if (!openLoaded) return;
    if (!nodes || !area) return;
    if (viewMode === 'occupied' || viewMode === 'time') return;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const load = async () => {
      if (isHidden()) return;
      const labels = openLabelsInArea;
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
            // Use stable sources that don't depend on "openAt" session timestamps:
            // - covers.getLast() for covers
            // - tickets.getLatestForTable() for a current snapshot total
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
          } catch (e) {
            void e;
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
        // Remove metrics for tables no longer open in this area
        for (const k of Object.keys(next)) {
          if (!k.startsWith(`${area}:`)) continue;
          const label = k.split(':').slice(1).join(':');
          if (!labels.includes(label)) delete next[k];
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
  }, [openLoaded, area, nodes, viewMode, openLabelsInArea]);

  // Time mode: prefetch "opened at" per open table so we can show duration without opening the ticket.
  useEffect(() => {
    if (!openLoaded) return;
    if (!nodes || !area) return;
    if (viewMode !== 'time') return;
    let cancelled = false;
    const isHidden = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const load = async () => {
      if (isHidden()) return;
      const labels = openLabelsInArea;
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
          } catch (e) {
            void e;
          }
        }
      });
      await Promise.all(workers);
      if (cancelled) return;

      setOpenedAtByTable((prev) => {
        const next: Record<string, string> = { ...prev };
        for (const [k, v] of updates) next[k] = v;
        // Remove entries for tables no longer open in this area
        for (const k of Object.keys(next)) {
          if (!k.startsWith(`${area}:`)) continue;
          const label = k.split(':').slice(1).join(':');
          if (!labels.includes(label)) delete next[k];
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
  }, [openLoaded, area, nodes, viewMode, openLabelsInArea]);

  useEffect(() => {
    if (viewMode !== 'time') return;
    const t = window.setInterval(() => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      )
        return;
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(t);
  }, [viewMode]);

  function formatMoney(n: number) {
    return formatMoneyCompact(currency, n);
  }

  // Track canvas size so we can auto-fit/center the layout on large screens.
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

  // Compute a "world" size so the canvas can scroll to reach off-screen tables on small screens.
  const worldSize = useMemo(() => {
    const cur = nodes || [];
    // Table circles are ~64x64; add generous padding so scrolling feels natural.
    const TABLE_R = 40;
    let maxX = 760;
    let maxY = 520;
    for (const n of cur as any[]) {
      if (!n) continue;
      if (String(n.kind || 'TABLE') === 'AREA') {
        const x = Number(n.x || 0);
        const y = Number(n.y || 0);
        const w = Number(n.w || 0);
        const h = Number(n.h || 0);
        maxX = Math.max(maxX, x + Math.max(0, w) + 80);
        maxY = Math.max(maxY, y + Math.max(0, h) + 80);
      } else {
        const x = Number(n.x || 0);
        const y = Number(n.y || 0);
        maxX = Math.max(maxX, x + TABLE_R + 80);
        maxY = Math.max(maxY, y + TABLE_R + 80);
      }
    }
    // Clamp to minimums so empty layouts still look good.
    return {
      // In view mode, ensure the "plan" fills the viewport even if tables are clustered.
      w: Math.max(760, Math.floor(maxX), editable ? 0 : canvasSize.w),
      h: Math.max(520, Math.floor(maxY), editable ? 0 : canvasSize.h),
    };
  }, [nodes, editable, canvasSize.w, canvasSize.h]);

  // Auto-fit/center layout in view mode (non-edit). This makes the restaurant plan fill the screen.
  const viewTransform = useMemo(() => {
    if (editable) return { scale: 1, tx: 0, ty: 0 };
    const cur = nodes || [];
    if (!cur.length) return { scale: 1, tx: 0, ty: 0 };
    const pad = 48;
    const cw = Math.max(0, canvasSize.w);
    const ch = Math.max(0, canvasSize.h);
    if (cw < 200 || ch < 200) return { scale: 1, tx: 0, ty: 0 };

    const tableHalf = 32; // circle is 64x64, positioned at center
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of cur as any[]) {
      if (!n) continue;
      if (String(n.kind || 'TABLE') === 'AREA') {
        const x = Number(n.x || 0);
        const y = Number(n.y || 0);
        const w = Number(n.w || 0);
        const h = Number(n.h || 0);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + Math.max(0, w));
        maxY = Math.max(maxY, y + Math.max(0, h));
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

  return (
    <div className="h-full flex flex-col gap-3 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Tables – {area}</h2>
        <div className="flex gap-2">
          {areas.map((a) => (
            <button
              key={a.name}
              className={`px-3 py-1 rounded ${area === a.name ? 'bg-gray-700' : 'bg-gray-800'} cursor-pointer`}
              onClick={() => setArea(a.name)}
            >
              {a.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`px-3 py-1 rounded ${editable ? 'bg-amber-700' : 'bg-gray-700'} cursor-pointer`}
            onClick={() => setEditable((v) => !v)}
          >
            {editable ? 'Editing…' : 'Edit layout'}
          </button>
          {editable && (
            <button
              className="px-3 py-1 rounded bg-emerald-700 cursor-pointer"
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
              className="px-3 py-1 rounded bg-emerald-700"
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
      </div>

      <div
        ref={canvasRef}
        className={`w-full flex-1 min-h-0 rounded bg-gray-800 ${editable ? 'overflow-hidden' : 'overflow-auto'}`}
        style={{
          WebkitOverflowScrolling: 'touch',
          // Allow finger panning on mobile when NOT editing.
          touchAction: editable ? ('none' as any) : ('pan-x pan-y' as any),
        }}
      >
        <div
          className="relative"
          style={{ width: worldSize.w, height: worldSize.h }}
        >
          {/* NOTE: In view mode we transform the whole plan (grid + nodes) so it fills the screen */}
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
            {/* simple grid background */}
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundSize: '40px 40px',
                backgroundImage:
                  'linear-gradient(to right, rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.08) 1px, transparent 1px)',
              }}
            />

            {/* Area boxes (for kitchen/bar/toilets etc) */}
            {nodes?.filter(isAreaNode).map((a) => (
              <AreaRect
                key={a.id}
                node={a}
                editable={editable}
                onMove={(x, y) =>
                  setNodes(
                    (prev) =>
                      prev?.map((n) =>
                        n.id === a.id ? { ...(n as any), x, y } : n,
                      ) ?? prev,
                  )
                }
                onResize={(w, h) =>
                  setNodes(
                    (prev) =>
                      prev?.map((n) =>
                        n.id === a.id ? { ...(n as any), w, h } : n,
                      ) ?? prev,
                  )
                }
                onRename={(label) =>
                  setNodes(
                    (prev) =>
                      prev?.map((n) =>
                        n.id === a.id ? { ...(n as any), label } : n,
                      ) ?? prev,
                  )
                }
                onDelete={() =>
                  setNodes((prev) => prev?.filter((n) => n.id !== a.id) ?? prev)
                }
              />
            ))}

            {openLoaded &&
              nodes?.filter(isTableNode).map((t) => (
                <DraggableCircle
                  key={t.id}
                  node={t}
                  editable={editable}
                  area={area}
                  onMove={(x, y) =>
                    setNodes(
                      (prev) =>
                        prev?.map((n) =>
                          n.id === t.id ? { ...(n as any), x, y } : n,
                        ) ?? prev,
                    )
                  }
                  onClick={() => {
                    if (editable) return;
                    setSelectedTable({ id: t.id, label: t.label, area });
                    const action = pendingAction;
                    if (action) setPendingAction(null);
                    // If table is open, hydrate current ticket from last sent ticket and skip covers prompt
                    if (isOpen(area, t.label)) {
                      (async () => {
                        const data = await window.api.tickets.getLatestForTable(
                          area,
                          t.label,
                        );
                        if (data)
                          hydrate({
                            items: data.items as any,
                            note: data.note || '',
                          });
                        navigate('/app/order');
                      })();
                      return;
                    }
                    // If table is free, start with a clean ticket
                    clear();
                    navigate('/app/order');
                    if (action) {
                      setTimeout(() => {
                        // no-op: could show a toast here if desired
                      }, 0);
                    }
                  }}
                  colorClass={(() => {
                    if (!isOpen(area, t.label)) return GREEN;
                    const ownerId = ownerByTable[`${area}:${t.label}`];
                    const uid = user?.id;
                    if (
                      ownerId != null &&
                      uid != null &&
                      Number(ownerId) === Number(uid)
                    )
                      return RED;
                    return ORANGE;
                  })()}
                  badge={
                    isOpen(area, t.label)
                      ? initialsByTable[`${area}:${t.label}`]
                      : undefined
                  }
                  ownerName={
                    (ownerByTable[`${area}:${t.label}`] &&
                      userMap[ownerByTable[`${area}:${t.label}`]]) ||
                    undefined
                  }
                  statusText={isOpen(area, t.label) ? 'OPEN' : 'FREE'}
                  viewMode={viewMode}
                  metricText={(() => {
                    const k = `${area}:${t.label}`;
                    const m = metricsByTable[k];
                    if (!isOpen(area, t.label)) return null;
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

          {!openLoaded && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-gray-900/60">
              <div className="bg-gray-800 border border-gray-700 rounded p-4 w-full max-w-sm">
                <div className="text-sm font-semibold mb-1">
                  Loading tables…
                </div>
                <div className="text-xs opacity-80">
                  {openLoadError ||
                    'Fetching occupied tables from the host PC.'}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <div className="text-xs opacity-70">Please wait</div>
                </div>
              </div>
            </div>
          )}
          {/* Sample bar counter/obstacles */}
          {area === 'Main Hall' && (
            <div
              className="absolute bottom-6 left-6 right-6 h-4 rounded bg-gray-700 opacity-70"
              title="Bar"
            />
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 bg-gray-800 rounded p-2">
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
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  onRename: (label: string) => void;
  onDelete: () => void;
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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.w}px`;
    el.style.height = `${node.h}px`;
  }, [node.x, node.y, node.w, node.h]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !editable) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't start dragging/resizing when clicking interactive controls inside the box.
      if (
        target &&
        (target.closest('button') ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA')
      ) {
        return;
      }
      const t = e.target as HTMLElement;
      const h = String(t?.dataset?.handle || '');
      modeRef.current =
        h === 'e' ? 'E' : h === 's' ? 'S' : h === 'se' ? 'SE' : 'DRAG';
      startRef.current = {
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
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
      if (modeRef.current === 'DRAG') {
        onMove(startRef.current.x + dx, startRef.current.y + dy);
      } else {
        const addW =
          modeRef.current === 'E' || modeRef.current === 'SE' ? dx : 0;
        const addH =
          modeRef.current === 'S' || modeRef.current === 'SE' ? dy : 0;
        onResize(
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
  }, [editable, node.x, node.y, node.w, node.h, onMove, onResize]);

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
                if (next) onRename(next);
                setRenaming(false);
              }
            }}
            onBlur={() => {
              const next = draftLabel.trim();
              if (next && next !== node.label) onRename(next);
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
              onDelete();
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
  onMove: (x: number, y: number) => void;
  onClick?: () => void;
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

  // Keep local position in sync when not dragging (e.g., load layout / switch area)
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
      // Position relative to parent center-coordinate system (because of translate -50%)
      const relX = e.clientX - parent.left;
      const relY = e.clientY - parent.top;
      const newX = Math.max(16, Math.min(parent.width - 16, relX));
      const newY = Math.max(16, Math.min(parent.height - 16, relY));
      const dx = newX - posRef.current.x;
      const dy = newY - posRef.current.y;
      dragDistanceRef.current += Math.sqrt(dx * dx + dy * dy);
      posRef.current = { x: newX, y: newY };

      // Throttle visual updates to once per animation frame for smooth dragging
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
      // Commit final position to parent state once (avoids re-render on every move)
      if (wasDragging) {
        const finalPos = posRef.current;
        setPos(finalPos);
        onMove(finalPos.x, finalPos.y);
        // Prevent accidental click right after dragging
        if (dragDistanceRef.current > 6)
          suppressClickUntilRef.current = Date.now() + 300;
      }
      e.preventDefault();
    };
    el.addEventListener('pointerdown', onPointerDown);
    // With pointer capture, move/up events will keep firing for this element
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
  }, [editable, onMove]);

  // Hover / long-press tooltip
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const fetchTip = async () => {
      try {
        if (!area) return;
        const t = await (window as any).api.tickets.getTableTooltip(
          area,
          node.label,
        );
        if (cancelled) return;
        setTooltip(t);
        setShowTip(true);
      } catch (e) {
        void e;
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
  }, [area, node.label]);

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
        onClick?.();
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
      className={`flex items-center gap-2 px-3 py-2 rounded ${active ? 'bg-gray-700' : 'bg-gray-900/40 hover:bg-gray-700/60'}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <span className={`${active ? 'text-white' : 'text-gray-200'} opacity-90`}>
        {children}
      </span>
      <span className="text-sm">{label}</span>
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
