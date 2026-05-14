import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session';
import { useOrderContext } from '@shared/stores/orderContext';
import { useNavigate } from 'react-router-dom';
import { useTableStatus } from '../../stores/tableStatus';
import { useTicketStore } from '../../stores/ticket';
import { formatMoneyCompact } from '../../utils/format';
import { PageSpinner } from '../../components/PageSpinner';

type TableStatus = 'FREE' | 'OCCUPIED' | 'RESERVED' | 'SERVED';
type TableShape = 'circle' | 'square' | 'rect';
type AreaVariant =
  | 'rect'
  | 'wall'
  | 'bar'
  | 'door'
  | 'plant'
  | 'pillar'
  | 'window'
  | 'stairs';

type TableNode = {
  id: number;
  kind?: 'TABLE';
  label: string;
  x: number;
  y: number;
  status: TableStatus;
  // Visual extras saved by the admin layout editor. All optional so
  // pre-shape layouts continue to render exactly as before.
  shape?: TableShape;
  w?: number;
  h?: number;
  seats?: number;
};
type AreaNode = {
  id: number;
  kind: 'AREA';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  variant?: AreaVariant;
  color?: string;
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
  const { t } = useTranslation();
  const [area, setArea] = useState<string>('Main Hall');
  // Seed with sensible defaults so the area pills + layout fetch
  // work immediately on mobile, even before `/settings` resolves.
  // Real values from settings overwrite these once they arrive.
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([
    { name: 'Main Hall', count: 8 },
    { name: 'Terrace', count: 4 },
  ]);
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

  // Live updates from any other client (Electron window or LAN tablet).
  // Both the IPC bridge (preload) and the SSE listener (main.tsx) emit
  // `pos:tablesChanged` with `{ area, label, open }`, so we only need
  // one listener here regardless of platform.
  useEffect(() => {
    const onChanged = (ev: any) => {
      try {
        const {
          area: a,
          label: l,
          open: o,
        } = (ev?.detail || {}) as {
          area?: string;
          label?: string;
          open?: boolean;
        };
        if (a && l && typeof o === 'boolean') setOpen(a, l, o);
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:tablesChanged', onChanged);
    return () => window.removeEventListener('pos:tablesChanged', onChanged);
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

  // Load layout when area changes. Layouts are now centrally managed
  // by the admin in Settings → Table Areas, so we trust the saved
  // layout verbatim — including its table count, shapes, seats and any
  // decor variants — and only fall back to defaults when the admin
  // has never saved a layout for this area.
  const loadLayoutForArea = useCallback(async () => {
    // The settings endpoint can be slow on mobile (cloud / capacitor),
    // and `areas` can briefly be empty before it resolves. Don't gate
    // the actual layout fetch on areas: with the centralised admin
    // layout, we just need `area` (a string) and the user's id —
    // everything else has a sensible default.
    if (!user) return;
    const cfg = areas.find((a) => a.name === area);
    const targetCount = cfg?.count ?? 8;
    const saved = await window.api.layout
      .get(user.id, area)
      .catch(() => null as any);
    if (Array.isArray(saved) && saved.length) {
      const savedAny = saved as any[];
      const tables = savedAny.filter((n) => !n?.kind || n.kind === 'TABLE');
      const areasSaved = savedAny.filter((n) => n?.kind === 'AREA');
      const normalizedTables = tables.map((n: any, i: number) => {
        const match = String(n.label || '').match(/^(?:[^0-9]*)(\d+)$/);
        const num = match ? Number(match[1]) : i + 1;
        // Preserve the new shape / size / seats fields so the waiter
        // view round-trips them when re-saving (and so a future
        // visual upgrade here picks them up automatically).
        return {
          ...n,
          id: Number(n.id) || i + 1,
          kind: 'TABLE',
          label: n.label || `T${num}`,
          x: Number(n.x || 0),
          y: Number(n.y || 0),
        } as TableNode;
      });
      const normalizedAreas = areasSaved.map((a: any, idx: number) => ({
        ...a,
        id: Number(a?.id) || -(idx + 1),
        kind: 'AREA' as const,
        label: String(a?.label ?? ''),
        x: Number(a?.x || 160),
        y: Number(a?.y || 160),
        w: Math.max(8, Number(a?.w || 260)),
        h: Math.max(8, Number(a?.h || 160)),
      })) as AreaNode[];
      setNodes([...(normalizedAreas as any), ...(normalizedTables as any)]);
      return;
    }
    setNodes(generateDefaultNodes(area, targetCount));
  }, [user, area, areas]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadLayoutForArea();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [loadLayoutForArea]);

  // Live update: admin saved a new shared layout from the AdminSettings
  // panel — refetch immediately so every waiter device matches without
  // waiting for a navigation away-and-back.
  useEffect(() => {
    const onLayoutChanged = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as { area?: string };
        if (detail.area && detail.area !== area) return;
        loadLayoutForArea();
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:layoutChanged', onLayoutChanged);
    return () =>
      window.removeEventListener('pos:layoutChanged', onLayoutChanged);
  }, [area, loadLayoutForArea]);

  // Compute which labels are open in the current area (stable via openMapKey)
  const openLabelsInArea = useMemo(() => {
    if (!nodes) return [] as string[];
    return nodes
      .filter(isTableNode)
      .filter((n) => isOpenFn(area, n.label))
      .map((n) => n.label);
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

  // Live updates: another client (Electron window or LAN tablet) just
  // wrote a TicketLog row. The badge `useEffect` above only re-fetches
  // when the *set* of open tables changes — so when waiter A appends an
  // item to a table that waiter B already had open, B's screen would
  // keep showing B's initials until the next 5s poll. By targeted-
  // refreshing just the affected table's badge / owner here, every
  // device flips to the actual latest waiter immediately. We trust the
  // payload's `userId` for an optimistic update so the UI reacts even
  // before the round-trip to `getLatestForTable` completes.
  useEffect(() => {
    const onTicketsChanged = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as {
          area?: string;
          tableLabel?: string;
          userId?: number | null;
        };
        const a = detail.area;
        const label = detail.tableLabel;
        if (!a || !label || a !== area) return;
        const k = `${a}:${label}`;
        const uid = Number(detail.userId);
        if (Number.isFinite(uid) && uid > 0) {
          setOwnerByTable((prev) => ({ ...prev, [k]: uid }));
          const name = userMap[uid];
          if (name)
            setInitialsByTable((prev) => ({ ...prev, [k]: toInitials(name) }));
        }
        // Authoritative refresh: fetch the latest ticket so we end up in
        // sync even if the optimistic uid was stale or the user map
        // hasn't loaded the new waiter yet.
        (async () => {
          try {
            const data = await window.api.tickets.getLatestForTable(a, label);
            const lid = Number(data?.userId || 0);
            if (!lid) return;
            setOwnerByTable((prev) => ({ ...prev, [k]: lid }));
            const nm = userMap[lid];
            if (nm)
              setInitialsByTable((prev) => ({
                ...prev,
                [k]: toInitials(nm),
              }));
          } catch {
            // ignore — the next badge effect cycle will recover it
          }
        })();
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:ticketsChanged', onTicketsChanged);
    return () =>
      window.removeEventListener('pos:ticketsChanged', onTicketsChanged);
  }, [area, userMap]);

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
    let maxX = 760;
    let maxY = 520;
    for (const n of cur as any[]) {
      if (!n) continue;
      if (String(n.kind || 'TABLE') === 'AREA') {
        maxX = Math.max(
          maxX,
          Number(n.x || 0) + Math.max(0, Number(n.w || 0)) + 80,
        );
        maxY = Math.max(
          maxY,
          Number(n.y || 0) + Math.max(0, Number(n.h || 0)) + 80,
        );
      } else {
        // Use the actual table size (rect tables can be 100×56) so we
        // never under-allocate the world canvas in editor mode.
        const halfW = Math.max(32, Number(n.w || 64) / 2);
        const halfH = Math.max(32, Number(n.h || 64) / 2);
        maxX = Math.max(maxX, Number(n.x || 0) + halfW + 80);
        maxY = Math.max(maxY, Number(n.y || 0) + halfH + 80);
      }
    }
    // In read-only (waiter) mode the auto-fit transform below scales
    // everything into the canvas viewport — so the world should be
    // pinned to the canvas size to avoid spurious scrollbars and
    // miscentered transforms. Only the editor needs a world larger
    // than the viewport (because editing happens at scale 1).
    if (!editable) {
      return {
        w: Math.max(1, canvasSize.w),
        h: Math.max(1, canvasSize.h),
      };
    }
    return {
      w: Math.max(760, Math.floor(maxX)),
      h: Math.max(520, Math.floor(maxY)),
    };
  }, [nodes, editable, canvasSize.w, canvasSize.h]);

  const viewTransform = useMemo(() => {
    const identity = { scale: 1, scaleX: 1, scaleY: 1, tx: 0, ty: 0 };
    if (editable) return identity;
    const cur = nodes || [];
    if (!cur.length) return identity;
    // Tight padding so the layout reaches the edges of the canvas
    // (avoids the perceived "shrunken canvas" when bh ≈ ch).
    const pad = 12;
    const cw = Math.max(0, canvasSize.w);
    const ch = Math.max(0, canvasSize.h);
    if (cw < 200 || ch < 200) return identity;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of cur as any[]) {
      if (!n) continue;
      // BOTH tables AND areas use `translate(-50%, -50%)` for
      // positioning, so `x, y` is the CENTRE of the node — not the
      // top-left corner. Treating areas as top-left was overestimating
      // bh by h/2 (and bw by w/2), shrinking the auto-fit scale and
      // leaving a big empty band at the bottom of the canvas.
      const x = Number(n.x || 0);
      const y = Number(n.y || 0);
      const isArea = String(n.kind || 'TABLE') === 'AREA';
      const halfW = isArea
        ? Math.max(0, Number(n.w || 0)) / 2
        : Math.max(32, Number(n.w || 64) / 2);
      const halfH = isArea
        ? Math.max(0, Number(n.h || 0)) / 2
        : Math.max(32, Number(n.h || 64) / 2);
      minX = Math.min(minX, x - halfW);
      minY = Math.min(minY, y - halfH);
      maxX = Math.max(maxX, x + halfW);
      maxY = Math.max(maxY, y + halfH);
    }
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    )
      return identity;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);

    // Independent x / y POSITION scales so the layout fills the
    // canvas in both directions instead of leaving empty bands on the
    // sides or below. Position scale is given a generous upper bound
    // so even small layouts spread out to use the available space —
    // children apply a counter-scale so tables themselves don't grow
    // beyond `shapeMaxScale` and stay nicely proportioned.
    const minScale = 0.3;
    const positionMaxScale = 6;
    const shapeMaxScale = 1.8;
    const clamp = (raw: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, raw));
    const scaleX = clamp((cw - pad * 2) / bw, minScale, positionMaxScale);
    const scaleY = clamp((ch - pad * 2) / bh, minScale, positionMaxScale);
    // Uniform shape scale: the smaller axis dictates how big shapes
    // can render so they never visually exceed their density-derived
    // slot. Cap separately so shapes don't blow up on very sparse
    // layouts even though positions are free to stretch.
    const scale = clamp(Math.min(scaleX, scaleY), minScale, shapeMaxScale);
    const tx = (cw - bw * scaleX) / 2 - minX * scaleX;
    const ty = (ch - bh * scaleY) / 2 - minY * scaleY;
    return { scale, scaleX, scaleY, tx, ty };
  }, [editable, nodes, canvasSize.w, canvasSize.h]);

  // -------- Pinch-to-zoom + drag-to-pan (read-only canvas) --------
  // `userZoom` is layered on TOP of the auto-fit transform: the
  // auto-fit places the floor edge-to-edge in the viewport, and this
  // user transform lets the staff zoom in for a closer look at busy
  // sections of the room and pan around when zoomed in.
  const [userZoom, setUserZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const userZoomRef = useRef(userZoom);
  userZoomRef.current = userZoom;
  const isZoomed = userZoom.scale > 1.02;
  const resetZoom = useCallback(
    () => setUserZoom({ scale: 1, tx: 0, ty: 0 }),
    [],
  );

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || editable) return;

    // We attach NATIVE touch listeners (passive: false) instead of
    // PointerEvents because iOS WebKit (used by both Safari and the
    // Capacitor WKWebView) can drop the second pointer when the first
    // lands on an interactive element such as a table circle. Native
    // touch events are reliable for multi-touch and let us call
    // preventDefault() to suppress the OS double-tap-zoom and any
    // residual page scrolling.

    let pinchStart: {
      d0: number;
      midX: number;
      midY: number;
      scale: number;
      tx: number;
      ty: number;
    } | null = null;
    let panStart: {
      x: number;
      y: number;
      tx: number;
      ty: number;
      moved: boolean;
    } | null = null;

    const ptFromTouch = (t: Touch) => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };

    const onTouchStart = (e: TouchEvent) => {
      const touches = e.touches;
      if (touches.length >= 2) {
        const a = ptFromTouch(touches[0]);
        const b = ptFromTouch(touches[1]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        pinchStart = {
          d0: Math.max(1, Math.hypot(dx, dy)),
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
          scale: userZoomRef.current.scale,
          tx: userZoomRef.current.tx,
          ty: userZoomRef.current.ty,
        };
        panStart = null;
        e.preventDefault();
      } else if (touches.length === 1 && userZoomRef.current.scale > 1.02) {
        const p = ptFromTouch(touches[0]);
        panStart = {
          x: p.x,
          y: p.y,
          tx: userZoomRef.current.tx,
          ty: userZoomRef.current.ty,
          moved: false,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const touches = e.touches;
      if (touches.length >= 2 && pinchStart) {
        const a = ptFromTouch(touches[0]);
        const b = ptFromTouch(touches[1]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d1 = Math.max(1, Math.hypot(dx, dy));
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const ratio = d1 / pinchStart.d0;
        const newScale = Math.max(1, Math.min(5, pinchStart.scale * ratio));
        const k = newScale / pinchStart.scale;
        const newTx =
          pinchStart.midX -
          k * (pinchStart.midX - pinchStart.tx) +
          (midX - pinchStart.midX);
        const newTy =
          pinchStart.midY -
          k * (pinchStart.midY - pinchStart.ty) +
          (midY - pinchStart.midY);
        setUserZoom({ scale: newScale, tx: newTx, ty: newTy });
        e.preventDefault();
      } else if (touches.length === 1 && panStart) {
        const p = ptFromTouch(touches[0]);
        const dxp = p.x - panStart.x;
        const dyp = p.y - panStart.y;
        if (!panStart.moved && Math.hypot(dxp, dyp) > 6) panStart.moved = true;
        if (panStart.moved) {
          setUserZoom((prev) => ({
            ...prev,
            tx: panStart!.tx + dxp,
            ty: panStart!.ty + dyp,
          }));
          e.preventDefault();
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchStart = null;
      if (e.touches.length === 0) panStart = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart as any);
      el.removeEventListener('touchmove', onTouchMove as any);
      el.removeEventListener('touchend', onTouchEnd as any);
      el.removeEventListener('touchcancel', onTouchEnd as any);
    };
  }, [editable]);

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
          prev?.map((n) => (n.id === id ? { ...(n as any), label } : n)) ??
          prev,
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
          const data = await window.api.tickets.getLatestForTable(
            area,
            t.label,
          );
          if (data)
            hydrate({ items: data.items as any, note: data.note || '' });
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

  // Floor layouts are now centrally managed by the admin from the
  // Settings → Table Areas screen, so this page is always read-only
  // here. Keeping the local `editable` state at `false` avoids a churn
  // through every callsite while still removing the toolbar UI below.
  const canEditLayout = false;

  return (
    <div className="h-full flex flex-col gap-2 sm:gap-3 min-h-0 overflow-hidden">
      {/* Top bar: title + area pills. On mobile, the H2 is hidden because
          the active area pill already shows context, and we keep all actions
          in a single horizontally-scrollable row. */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="hidden sm:block text-lg font-semibold whitespace-nowrap">
          {t('tables.title', { area })}
        </h2>
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 sm:mx-0 sm:px-0 flex-1 sm:flex-initial">
          {areas.map((a) => (
            <button
              key={a.name}
              className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap min-h-0 transition-colors duration-150 ${
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
              {editable ? t('tables.editing') : t('tables.editLayout')}
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
                {t('tables.addArea')}
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
                {t('common.save')}
              </button>
            )}
          </div>
        )}
      </div>

      <div
        ref={canvasRef}
        className={`w-full flex-1 min-h-0 rounded bg-gray-800 relative ${
          editable ? 'overflow-auto' : 'overflow-hidden touch-none'
        }`}
      >
        {!editable && isZoomed && (
          <button
            type="button"
            onClick={resetZoom}
            className="absolute top-2 right-2 z-20 px-2.5 py-1.5 rounded-full bg-gray-900/80 backdrop-blur text-xs font-semibold text-white border border-white/10 shadow-lg active:scale-95"
            title={t('tables.resetZoom')}
          >
            {t('tables.resetZoomPct', {
              pct: Math.round(userZoom.scale * 100),
            })}
          </button>
        )}

        <div
          className={editable ? 'relative' : 'absolute inset-0'}
          style={
            editable
              ? { width: worldSize.w, height: worldSize.h }
              : ({
                  // User pinch-zoom + pan layer wraps the auto-fit
                  // transform so users can zoom into busy parts of the
                  // floor without disrupting the read-only fit.
                  transform: `translate(${userZoom.tx}px, ${userZoom.ty}px) scale(${userZoom.scale})`,
                  transformOrigin: '0 0',
                  willChange: 'transform',
                } as React.CSSProperties)
          }
        >
          <div
            className={
              editable ? 'absolute inset-0' : 'absolute inset-0 touch-none'
            }
            style={
              editable
                ? undefined
                : ({
                    transform: `translate(${viewTransform.tx}px, ${viewTransform.ty}px) scale(${viewTransform.scaleX}, ${viewTransform.scaleY})`,
                    transformOrigin: 'top left',
                    // Children read these to counter-distort their own
                    // shapes (so circles stay circles even when the
                    // wrapper is non-uniformly scaled to spread positions
                    // across the whole grid).
                    ['--floor-cx' as any]:
                      viewTransform.scaleX > 0
                        ? viewTransform.scale / viewTransform.scaleX
                        : 1,
                    ['--floor-cy' as any]:
                      viewTransform.scaleY > 0
                        ? viewTransform.scale / viewTransform.scaleY
                        : 1,
                  } as React.CSSProperties)
            }
          >
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

            {nodes?.filter(isTableNode).map((tableNode) => (
              <MemoDraggableCircle
                key={tableNode.id}
                node={tableNode}
                editable={editable}
                area={area}
                onMove={handleNodeMove}
                onClick={handleTableClick}
                colorClass={(() => {
                  if (!isOpenFn(area, tableNode.label)) return GREEN;
                  const ownerId = ownerByTable[`${area}:${tableNode.label}`];
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
                  isOpenFn(area, tableNode.label)
                    ? initialsByTable[`${area}:${tableNode.label}`]
                    : undefined
                }
                ownerName={
                  (ownerByTable[`${area}:${tableNode.label}`] &&
                    userMap[ownerByTable[`${area}:${tableNode.label}`]]) ||
                  undefined
                }
                statusText={
                  isOpenFn(area, tableNode.label)
                    ? t('tables.statusOpen')
                    : t('tables.statusFree')
                }
                viewMode={viewMode}
                metricText={(() => {
                  const k = `${area}:${tableNode.label}`;
                  const m = metricsByTable[k];
                  if (!isOpenFn(area, tableNode.label)) return null;
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
        </div>
      </div>

      <div className="flex items-stretch sm:items-center justify-center gap-1.5 sm:gap-2 bg-gray-800/80 backdrop-blur rounded-lg p-1.5 sm:p-2 shrink-0">
        <ModeButton
          active={viewMode === 'occupied'}
          onClick={() => setViewMode('occupied')}
          label={t('tables.modeOccupied')}
        >
          <IconUsers />
        </ModeButton>
        <ModeButton
          active={viewMode === 'covers'}
          onClick={() => setViewMode('covers')}
          label={t('tables.modeCovers')}
        >
          <IconCovers />
        </ModeButton>
        <ModeButton
          active={viewMode === 'revenue'}
          onClick={() => setViewMode('revenue')}
          label={t('tables.modeRevenue')}
        >
          <IconMoney />
        </ModeButton>
        <ModeButton
          active={viewMode === 'time'}
          onClick={() => setViewMode('time')}
          label={t('tables.modeTime')}
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
        onMoveRef.current(
          n.id,
          startRef.current.x + dx,
          startRef.current.y + dy,
        );
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

  const variant: AreaVariant = node.variant ?? 'rect';
  const fill = node.color ?? defaultAreaColor(variant);
  const styling = areaVariantStyling(variant, fill);
  const showLabel = variant === 'rect' || variant === 'bar' || !!node.label;
  return (
    <div
      ref={ref}
      className={`absolute ${styling.className} ${editable ? 'cursor-move' : 'pointer-events-none'} select-none`}
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        height: node.h,
        touchAction: 'none' as any,
        ...styling.style,
        // Counter-scale (--floor-cx / --floor-cy) is set on the parent
        // wrapper in non-editable mode so shapes stay proportional even
        // when positions are spread non-uniformly across the canvas.
        transform:
          'translate(-50%, -50%) scale(var(--floor-cx, 1), var(--floor-cy, 1))',
        transformOrigin: 'center',
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
      title={editable ? 'Double click to rename' : node.label || variant}
    >
      {/* Variant decoration so each shape reads at a glance: walls are
          solid, doors have a swing line, windows have a mullion, etc. */}
      {variant === 'window' && (
        <div className="absolute inset-0 flex items-center pointer-events-none">
          <div className="w-full border-t border-white/40" />
        </div>
      )}
      {variant === 'stairs' && (
        <div className="absolute inset-1 flex flex-col justify-between pointer-events-none">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-px bg-white/40" />
          ))}
        </div>
      )}
      {variant === 'door' && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="w-3/4 border-b-2 border-dashed border-white/60" />
        </div>
      )}
      {(variant === 'plant' || variant === 'pillar') && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center text-white/80 text-base">
          {variant === 'plant' ? '🌿' : '◼'}
        </div>
      )}
      {showLabel && (
        <div
          className={`absolute left-2 top-2 text-xs font-semibold ${
            variant === 'rect'
              ? 'text-emerald-300'
              : 'text-white/90 drop-shadow'
          }`}
        >
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
                  onRename(node.id, next);
                  setRenaming(false);
                }
              }}
              onBlur={() => {
                const next = draftLabel.trim();
                if (next !== node.label) onRename(node.id, next);
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
      )}
      {editable && (
        <>
          <button
            type="button"
            aria-label="Delete shape"
            className="absolute bg-rose-600 hover:bg-rose-500 text-white shadow ring-2 ring-gray-900 z-10 flex items-center justify-center"
            style={{
              width: 22,
              height: 22,
              top: -10,
              right: -10,
              padding: 0,
              borderRadius: '50%',
              fontSize: 11,
              lineHeight: 1,
              boxSizing: 'border-box',
            }}
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

// Map an area variant + fill colour to the wrapper's class + inline
// style. Mirrors the helper inside FloorCanvas so both the admin
// editor and the waiter view render decor identically.
function defaultAreaColor(variant: AreaVariant): string {
  switch (variant) {
    case 'wall':
      return '#1f2937';
    case 'bar':
      return '#92400e';
    case 'door':
      return '#9ca3af';
    case 'plant':
      return '#15803d';
    case 'pillar':
      return '#374151';
    case 'window':
      return '#7dd3fc';
    case 'stairs':
      return '#4b5563';
    case 'rect':
    default:
      return '';
  }
}

function areaVariantStyling(
  variant: AreaVariant,
  fill: string,
): { className: string; style: React.CSSProperties } {
  switch (variant) {
    case 'wall':
      return {
        className: 'rounded-sm',
        style: { backgroundColor: fill || '#1f2937' },
      };
    case 'bar':
      return {
        className: 'rounded-md shadow-inner',
        style: {
          backgroundImage: `linear-gradient(180deg, ${fill || '#92400e'} 0%, rgba(0,0,0,0.25) 100%)`,
          backgroundColor: fill || '#92400e',
        },
      };
    case 'door':
      return {
        className: 'rounded-sm',
        style: { backgroundColor: fill || '#9ca3af', opacity: 0.85 },
      };
    case 'plant':
      return {
        className: 'rounded-full shadow',
        style: { backgroundColor: fill || '#15803d' },
      };
    case 'pillar':
      return {
        className: 'rounded-full shadow-md',
        style: { backgroundColor: fill || '#374151' },
      };
    case 'window':
      return {
        className: 'rounded-sm',
        style: { backgroundColor: fill || '#7dd3fc', opacity: 0.8 },
      };
    case 'stairs':
      return {
        className: 'rounded-sm',
        style: { backgroundColor: fill || '#4b5563' },
      };
    case 'rect':
    default:
      return {
        className: 'border-2 border-emerald-500 bg-transparent rounded',
        style: fill ? { backgroundColor: fill, opacity: 0.25 } : {},
      };
  }
}

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
  const { t } = useTranslation();
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

  const shape: TableShape = node.shape ?? 'circle';
  const w = Math.max(36, Number(node.w) || (shape === 'rect' ? 100 : 64));
  const h = Math.max(36, Number(node.h) || (shape === 'rect' ? 56 : 64));
  const radius =
    shape === 'circle' ? '9999px' : shape === 'square' ? '10px' : '12px';
  return (
    <div
      ref={ref}
      className={`absolute ${colorClass || GREEN} flex items-center justify-center shadow-lg ${editable ? 'cursor-move' : 'cursor-pointer'} select-none overflow-hidden`}
      style={{
        left: pos.x,
        top: pos.y,
        width: w,
        height: h,
        borderRadius: radius,
        touchAction: 'none' as any,
        willChange: editable ? ('transform,left,top' as any) : undefined,
        // Counter-scale (--floor-cx / --floor-cy) keeps the shape proportional
        // even when the parent wrapper applies a non-uniform scale to spread
        // positions across the whole grid.
        transform:
          'translate(-50%, -50%) scale(var(--floor-cx, 1), var(--floor-cy, 1))',
        transformOrigin: 'center',
      }}
      title={`${node.label} • ${statusText || node.status}${
        node.seats ? t('tables.titleSeatsFragment', { count: node.seats }) : ''
      }`}
      onClick={() => {
        if (Date.now() < suppressClickUntilRef.current) return;
        onClickRef.current?.(nodeRef.current);
      }}
    >
      <div className="flex flex-col items-center leading-none px-1">
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
            <span className="mt-0.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-black/40 max-w-[80px] text-center leading-[1.05] break-words">
              {viewMode === 'covers'
                ? t('tables.coversChip', { val: metricText })
                : metricText}
            </span>
          )
        )}
      </div>
      {/* Capacity badge — shown in 'occupied' view when there's no
          status badge / no metric to display, so we don't double up. */}
      {node.seats && viewMode === 'occupied' && !badge && !statusText && (
        <span className="absolute bottom-0.5 right-1 text-[10px] font-semibold opacity-80">
          {node.seats}
        </span>
      )}
      {showTip && tooltip && (
        <div className="absolute top-18 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs bg-black/80 text-white px-2 py-1 rounded shadow">
          {ownerName && <div>{ownerName}</div>}
          <div>
            {t('tables.tooltipGuestsLine', {
              val: tooltip.covers ?? '-',
            })}
          </div>
          <div>
            {t('tables.tooltipSince')}{' '}
            {tooltip.firstAt
              ? new Date(tooltip.firstAt).toLocaleTimeString()
              : '-'}
          </div>
          <div>
            {t('tables.tooltipTotal')}{' '}
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
      className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 rounded-lg transition-colors duration-150 min-h-0 ${
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
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM4 20a7 7 0 0 1 16 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCovers() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M12 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM2 22a7 7 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M20 8a3 3 0 1 0-6 0 3 3 0 0 0 6 0ZM13.5 22a6 6 0 0 1 8.5-5.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoney() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M7 7h10a4 4 0 0 1 0 8H9a3 3 0 0 0 0 6h8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 3v18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconClock() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="pos-icon"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M12 22a10 10 0 1 0-10-10 10 10 0 0 0 10 10Z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 6v6l4 2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
