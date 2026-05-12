// FloorCanvas — a focused, reusable floor plan editor used by the
// reservation panel. It's intentionally self-contained instead of being
// extracted out of TablesPage.tsx so adding the new feature can't destabilise
// the waiter UX. The data shape (TableNode/AreaNode with x,y) and the IPCs
// (window.api.layout.{get,save}) are identical to TablesPage so a layout
// saved here is forward-compatible with future refactors.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Tables can render as one of three shapes. `circle` is the historical
// default and is preserved when the saved layout doesn't include `shape`.
export type TableShape = 'circle' | 'square' | 'rect';

export type FloorTableNode = {
  id: number;
  kind?: 'TABLE';
  label: string;
  x: number;
  y: number;
  // Visual customisation. All optional — older layouts simply omit them
  // and we fall back to `circle` / 64×64 / no seat badge.
  shape?: TableShape;
  w?: number;
  h?: number;
  seats?: number;
};

// Decor / fixture pieces that go behind the tables on the floor map.
// Each `variant` has its own visual treatment so a real restaurant
// floor reads at a glance: walls are dark blocks, bars are warm
// counters, plants are small green discs, etc.
export type AreaVariant =
  | 'rect' // labelled outlined rectangle (legacy)
  | 'wall'
  | 'bar'
  | 'door'
  | 'plant'
  | 'pillar'
  | 'window'
  | 'stairs';

export type FloorAreaNode = {
  id: number;
  kind: 'AREA';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  variant?: AreaVariant;
  /** Optional CSS color override for the fill. Falls back to the
   *  variant's default palette. Stored as a CSS color string so we can
   *  ship a small swatch picker without depending on Tailwind classes
   *  in the saved JSON. */
  color?: string;
};

export type FloorNode = FloorTableNode | FloorAreaNode;

export function isFloorAreaNode(n: FloorNode): n is FloorAreaNode {
  return (n as any)?.kind === 'AREA';
}
export function isFloorTableNode(n: FloorNode): n is FloorTableNode {
  return !isFloorAreaNode(n);
}

// ---- Shape catalogues used by the toolbar dropdowns ----

const TABLE_SHAPE_PRESETS: Array<{
  shape: TableShape;
  label: string;
  w: number;
  h: number;
  seats: number;
}> = [
  { shape: 'circle', label: 'Round (2-4)', w: 64, h: 64, seats: 2 },
  { shape: 'square', label: 'Square (4)', w: 64, h: 64, seats: 4 },
  { shape: 'rect', label: 'Rectangle (6)', w: 100, h: 56, seats: 6 },
];

const AREA_VARIANT_PRESETS: Array<{
  variant: AreaVariant;
  label: string;
  w: number;
  h: number;
  defaultLabel: string;
}> = [
  {
    variant: 'rect',
    label: 'Plain area',
    w: 220,
    h: 140,
    defaultLabel: 'Area',
  },
  { variant: 'wall', label: 'Wall', w: 220, h: 16, defaultLabel: '' },
  {
    variant: 'bar',
    label: 'Bar / Counter',
    w: 220,
    h: 50,
    defaultLabel: 'Bar',
  },
  { variant: 'door', label: 'Door', w: 60, h: 16, defaultLabel: 'Door' },
  { variant: 'plant', label: 'Plant', w: 48, h: 48, defaultLabel: '' },
  { variant: 'pillar', label: 'Pillar', w: 32, h: 32, defaultLabel: '' },
  { variant: 'window', label: 'Window', w: 160, h: 16, defaultLabel: '' },
  { variant: 'stairs', label: 'Stairs', w: 120, h: 60, defaultLabel: 'Stairs' },
];

const SHAPE_COLOR_PALETTE: string[] = [
  '#6b7280', // slate gray
  '#374151', // dark gray (walls)
  '#92400e', // brown (bar / wood)
  '#b45309', // amber (warm wood)
  '#15803d', // emerald (plants)
  '#0e7490', // cyan (window)
  '#7c3aed', // violet (decorative)
  '#be123c', // rose (warning / fire exit)
];

function defaultAreaColor(variant: AreaVariant): string {
  switch (variant) {
    case 'wall':
      return '#1f2937'; // gray-800 — solid dark wall
    case 'bar':
      return '#92400e'; // amber-800 — wood counter
    case 'door':
      return '#9ca3af'; // gray-400 — light door slab
    case 'plant':
      return '#15803d'; // emerald-700 — plant fill
    case 'pillar':
      return '#374151'; // gray-700 — column
    case 'window':
      return '#7dd3fc'; // sky-300 — glass
    case 'stairs':
      return '#4b5563'; // gray-600 — concrete steps
    case 'rect':
    default:
      return '';
  }
}

function generateDefaultTables(count: number): FloorTableNode[] {
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
    return { id: i + 1, kind: 'TABLE', label: `T${i + 1}`, x, y };
  });
}

function nextAreaId(cur: FloorNode[] | null): number {
  const ids = (cur || []).map((n) => n.id);
  const min = ids.length ? Math.min(...ids) : 0;
  return min <= 0 ? min - 1 : -1;
}

function normaliseSavedNodes(saved: any[]): FloorNode[] {
  const tables = (saved as any[])
    .filter((n) => !n?.kind || n.kind === 'TABLE')
    .map((n: any, i: number) => {
      const m = String(n.label || '').match(/^(?:[^0-9]*)(\d+)$/);
      const num = m ? Number(m[1]) : i + 1;
      const shape: TableShape =
        n?.shape === 'square' || n?.shape === 'rect' ? n.shape : 'circle';
      return {
        id: Number(n.id) || i + 1,
        kind: 'TABLE' as const,
        label: String(n.label || `T${num}`),
        x: Number(n.x || 0),
        y: Number(n.y || 0),
        shape,
        w:
          Number.isFinite(Number(n?.w)) && Number(n.w) > 0
            ? Number(n.w)
            : shape === 'rect'
              ? 100
              : 64,
        h:
          Number.isFinite(Number(n?.h)) && Number(n.h) > 0
            ? Number(n.h)
            : shape === 'rect'
              ? 56
              : 64,
        seats:
          Number.isFinite(Number(n?.seats)) && Number(n.seats) > 0
            ? Number(n.seats)
            : undefined,
      } as FloorTableNode;
    });
  const areas = (saved as any[])
    .filter((n) => n?.kind === 'AREA')
    .map((a: any, idx: number) => {
      const variant: AreaVariant = isAreaVariant(a?.variant)
        ? a.variant
        : 'rect';
      return {
        id: Number(a?.id) || -(idx + 1),
        kind: 'AREA' as const,
        label: String(a?.label ?? ''),
        x: Number(a?.x || 160),
        y: Number(a?.y || 160),
        w: Math.max(8, Number(a?.w || 220)),
        h: Math.max(8, Number(a?.h || 140)),
        variant,
        color:
          typeof a?.color === 'string' && a.color.trim() ? a.color : undefined,
      } as FloorAreaNode;
    });
  return [...(areas as any), ...(tables as any)];
}

function isAreaVariant(v: any): v is AreaVariant {
  return (
    v === 'rect' ||
    v === 'wall' ||
    v === 'bar' ||
    v === 'door' ||
    v === 'plant' ||
    v === 'pillar' ||
    v === 'window' ||
    v === 'stairs'
  );
}

function nextTableLabel(cur: FloorNode[] | null): string {
  const used = new Set<number>();
  for (const n of cur || []) {
    if (!isFloorTableNode(n)) continue;
    const m = String(n.label).match(/^(?:[^0-9]*)(\d+)$/);
    if (m) used.add(Number(m[1]));
  }
  let i = 1;
  while (used.has(i)) i++;
  return `T${i}`;
}

const GREEN = 'bg-emerald-700';

type ColorMap = Record<string, string>; // label -> tailwind class
type BadgeMap = Record<string, string | null | undefined>;

type FloorCanvasProps = {
  userId: number;
  area: string;
  scope?: string; // layout namespace; default 'pos'
  defaultCount?: number; // when no saved layout exists
  editable: boolean;
  onEditableChange?: (next: boolean) => void;
  /** Grow to fill a parent flex column (reservations floor). Default uses viewport-based height for modals. */
  fillAvailableHeight?: boolean;
  // Visual overrides
  colorByLabel?: ColorMap;
  badgeByLabel?: BadgeMap;
  // Interactions
  onTableClick?: (label: string) => void;
};

export default function FloorCanvas({
  userId,
  area,
  scope = 'pos',
  defaultCount = 8,
  editable,
  onEditableChange,
  fillAvailableHeight = false,
  colorByLabel,
  badgeByLabel,
  onTableClick,
}: FloorCanvasProps) {
  const [nodes, setNodes] = useState<FloorNode[] | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Track the actual visible canvas size so the read-only auto-fit
  // transform can stretch the layout to fill the full canvas — both
  // axes — instead of leaving big empty bands on the right / bottom.
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  // Load layout on user/area/scope change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId || !area) return;
      const saved = await (window as any).api.layout
        .get(userId, area, scope)
        .catch(() => null);
      if (cancelled) return;
      if (Array.isArray(saved) && saved.length) {
        setNodes(normaliseSavedNodes(saved));
        setDirty(false);
        return;
      }
      setNodes(generateDefaultTables(defaultCount));
      setDirty(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, area, scope, defaultCount]);

  const handleMove = useCallback((id: number, x: number, y: number) => {
    setNodes((prev) =>
      (prev || []).map((n) => (n.id === id ? { ...(n as any), x, y } : n)),
    );
    setDirty(true);
  }, []);

  const handleAreaResize = useCallback((id: number, w: number, h: number) => {
    setNodes((prev) =>
      (prev || []).map((n) => (n.id === id ? { ...(n as any), w, h } : n)),
    );
    setDirty(true);
  }, []);

  const handleAreaRename = useCallback((id: number, label: string) => {
    setNodes((prev) =>
      (prev || []).map((n) => (n.id === id ? { ...(n as any), label } : n)),
    );
    setDirty(true);
  }, []);

  const handleDelete = useCallback((id: number) => {
    setNodes((prev) => (prev || []).filter((n) => n.id !== id));
    setDirty(true);
  }, []);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [addMenu, setAddMenu] = useState<null | 'table' | 'shape'>(null);

  // Deselect when leaving editable mode so the inspector disappears.
  useEffect(() => {
    if (!editable) {
      setSelectedId(null);
      setAddMenu(null);
    }
  }, [editable]);

  // Dismiss the +Table / +Shape dropdown when clicking anywhere outside
  // the toolbar.
  useEffect(() => {
    if (!addMenu) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest('[data-floor-add-menu]')) return;
      setAddMenu(null);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [addMenu]);

  const addTableOfShape = useCallback(
    (preset: { shape: TableShape; w: number; h: number; seats: number }) => {
      setNodes((prev) => {
        const cur = prev || [];
        const rect = canvasRef.current?.getBoundingClientRect();
        const x = rect ? Math.max(60, rect.width * 0.5) : 240;
        const y = rect ? Math.max(60, rect.height * 0.5) : 200;
        const usedIds = new Set(cur.map((n) => n.id).filter((n) => n > 0));
        let id = 1;
        while (usedIds.has(id)) id++;
        const label = nextTableLabel(cur);
        const node: FloorTableNode = {
          id,
          kind: 'TABLE',
          label,
          x,
          y,
          shape: preset.shape,
          w: preset.w,
          h: preset.h,
          seats: preset.seats,
        };
        setSelectedId(id);
        return [...cur, node];
      });
      setDirty(true);
      setAddMenu(null);
    },
    [],
  );

  const addAreaOfVariant = useCallback(
    (preset: {
      variant: AreaVariant;
      w: number;
      h: number;
      defaultLabel: string;
    }) => {
      setNodes((prev) => {
        const cur = prev || [];
        const id = nextAreaId(cur);
        const rect = canvasRef.current?.getBoundingClientRect();
        const x = rect ? Math.max(120, rect.width * 0.5) : 240;
        const y = rect ? Math.max(120, rect.height * 0.4) : 180;
        const node: FloorAreaNode = {
          id,
          kind: 'AREA',
          label: preset.defaultLabel,
          x,
          y,
          w: preset.w,
          h: preset.h,
          variant: preset.variant,
        };
        setSelectedId(id);
        return [...cur, node];
      });
      setDirty(true);
      setAddMenu(null);
    },
    [],
  );

  // Per-node patch helper used by the inspector to update shape/colour/etc.
  const patchNode = useCallback((id: number, patch: Partial<FloorNode>) => {
    setNodes((prev) =>
      (prev || []).map((n) =>
        n.id === id ? ({ ...(n as any), ...(patch as any) } as FloorNode) : n,
      ),
    );
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!nodes) return;
    setSaving(true);
    try {
      await (window as any).api.layout.save(userId, area, nodes, scope);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [nodes, userId, area, scope]);

  const tables = useMemo(() => (nodes || []).filter(isFloorTableNode), [nodes]);
  const areas = useMemo(() => (nodes || []).filter(isFloorAreaNode), [nodes]);

  // The edit toolbar is only rendered when the host page provides an
  // `onEditableChange` callback. Waiter and Host floor views render
  // the canvas read-only — only the AdminSettings → Table Areas editor
  // owns the toggle and the +Table / +Shape / Save controls.
  const showToolbar = typeof onEditableChange === 'function';

  // Observe the outer canvas wrapper so the read-only auto-fit
  // transform always uses the latest visible dimensions.
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setCanvasSize({
        w: Math.max(0, Math.floor(r.width)),
        h: Math.max(0, Math.floor(r.height)),
      });
    };
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Auto-fit transform — applied only in read-only (waiter / host)
  // mode so the layout fills the entire visible canvas in BOTH axes.
  // Position scale is non-uniform (so the floor reaches every edge);
  // children apply a counter-scale so individual shapes stay
  // proportional. Editor mode keeps free-positioning at scale 1.
  const viewTransform = useMemo(() => {
    const identity = { scale: 1, scaleX: 1, scaleY: 1, tx: 0, ty: 0 };
    if (editable) return identity;
    const cur = nodes || [];
    if (!cur.length) return identity;
    const cw = Math.max(0, canvasSize.w);
    const ch = Math.max(0, canvasSize.h);
    if (cw < 200 || ch < 200) return identity;
    const pad = 12;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of cur as any[]) {
      if (!n) continue;
      // Both tables and areas use translate(-50%, -50%), so x/y is
      // the CENTRE of the node — measure the half-extents on each axis.
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
    const minScale = 0.3;
    const positionMaxScale = 6;
    const shapeMaxScale = 1.8;
    const clamp = (raw: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, raw));
    const scaleX = clamp((cw - pad * 2) / bw, minScale, positionMaxScale);
    const scaleY = clamp((ch - pad * 2) / bh, minScale, positionMaxScale);
    const scale = clamp(Math.min(scaleX, scaleY), minScale, shapeMaxScale);
    const tx = (cw - bw * scaleX) / 2 - minX * scaleX;
    const ty = (ch - bh * scaleY) / 2 - minY * scaleY;
    return { scale, scaleX, scaleY, tx, ty };
  }, [editable, nodes, canvasSize.w, canvasSize.h]);

  // -------- Pinch-to-zoom + drag-to-pan (read-only canvas) --------
  // Layered ON TOP of the auto-fit transform: hosts can pinch to zoom
  // into a section of the floor and pan around when zoomed in.
  const [userZoom, setUserZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const userZoomRef = useRef(userZoom);
  userZoomRef.current = userZoom;
  const isZoomed = userZoom.scale > 1.02;
  const resetZoom = useCallback(
    () => setUserZoom({ scale: 1, tx: 0, ty: 0 }),
    [],
  );

  useEffect(() => {
    const el = outerRef.current;
    if (!el || editable) return;
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

    // Use NATIVE TouchEvents (passive: false) instead of PointerEvents.
    // iOS WebKit drops the second pointer in some scenarios when the first
    // lands on an interactive child, but TouchEvents always report all
    // active fingers. preventDefault() also stops the OS double-tap-zoom.

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

  // Listen for shared-layout updates: when the admin saves the layout
  // for this area on any device, every other device's read-only floor
  // view refetches without a page refresh.
  useEffect(() => {
    const onLayoutChanged = (ev: any) => {
      try {
        const detail = (ev?.detail || {}) as { area?: string };
        if (!area || !detail.area || detail.area !== area) return;
        // Don't blow away an in-progress edit: when the editor is open
        // (`dirty === true`), respect the local draft and let the admin
        // save explicitly. Read-only views always pick up the change.
        if (editable && dirty) return;
        (async () => {
          try {
            const saved = await (window as any).api.layout
              .get(userId, area, scope)
              .catch(() => null);
            if (!Array.isArray(saved)) return;
            setNodes(normaliseSavedNodes(saved));
            setDirty(false);
          } catch {
            // ignore
          }
        })();
      } catch {
        // ignore
      }
    };
    window.addEventListener('pos:layoutChanged', onLayoutChanged);
    return () =>
      window.removeEventListener('pos:layoutChanged', onLayoutChanged);
  }, [area, userId, scope, editable, dirty]);

  const shellStaticHeightClasses =
    'h-[calc(100dvh-260px)] min-h-[320px] sm:h-[calc(100vh-300px)] sm:min-h-[420px] max-h-[1100px]';

  return (
    <div
      className={
        fillAvailableHeight ? 'flex min-h-0 flex-1 flex-col gap-2' : 'space-y-2'
      }
    >
      {showToolbar && (
        <div className="relative flex shrink-0 items-center gap-2 flex-wrap">
          <button
            type="button"
            className={`px-3 py-1.5 rounded text-sm ${editable ? 'bg-amber-600 hover:bg-amber-500' : 'bg-gray-700 hover:bg-gray-600'}`}
            onClick={() => onEditableChange?.(!editable)}
          >
            {editable ? 'Editing…' : 'Edit layout'}
          </button>
          {editable && (
            <>
              <div className="relative" data-floor-add-menu>
                <button
                  type="button"
                  className="px-3 py-1.5 rounded text-sm bg-emerald-700 hover:bg-emerald-600"
                  onClick={() =>
                    setAddMenu((m) => (m === 'table' ? null : 'table'))
                  }
                >
                  + Table ▾
                </button>
                {addMenu === 'table' && (
                  <div
                    data-floor-add-menu
                    className="absolute z-30 mt-1 left-0 w-56 bg-gray-800 border border-gray-700 rounded shadow-lg p-1"
                  >
                    {TABLE_SHAPE_PRESETS.map((p) => (
                      <button
                        key={p.shape}
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-gray-700 text-left"
                        onClick={() => addTableOfShape(p)}
                      >
                        <ShapePreview kind="table" shape={p.shape} />
                        <span className="text-sm">{p.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="relative" data-floor-add-menu>
                <button
                  type="button"
                  className="px-3 py-1.5 rounded text-sm bg-emerald-800 hover:bg-emerald-700"
                  onClick={() =>
                    setAddMenu((m) => (m === 'shape' ? null : 'shape'))
                  }
                >
                  + Shape ▾
                </button>
                {addMenu === 'shape' && (
                  <div
                    data-floor-add-menu
                    className="absolute z-30 mt-1 left-0 w-56 bg-gray-800 border border-gray-700 rounded shadow-lg p-1"
                  >
                    {AREA_VARIANT_PRESETS.map((p) => (
                      <button
                        key={p.variant}
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-gray-700 text-left"
                        onClick={() => addAreaOfVariant(p)}
                      >
                        <ShapePreview kind="area" variant={p.variant} />
                        <span className="text-sm">{p.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={saving || !dirty}
                className={`px-3 py-1.5 rounded text-sm ${dirty ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-700 opacity-60'}`}
                onClick={save}
              >
                {saving ? 'Saving…' : dirty ? 'Save layout' : 'Saved'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Outer shell provides the visual frame. In editor mode it
          allows horizontal scroll for design widths > viewport. In
          read-only mode we auto-fit so no scroll is needed and the
          floor stretches to fill the entire canvas. The grid is
          rendered on the OUTER wrapper so it always covers the full
          visible canvas regardless of the inner transform's scale. */}
      <div
        ref={outerRef}
        className={`relative rounded-lg border border-gray-700 bg-gray-900 ${
          fillAvailableHeight ? 'min-h-0 flex-1' : shellStaticHeightClasses
        } ${editable ? 'overflow-x-auto overflow-y-hidden' : 'overflow-hidden touch-none'}`}
        // Subtle floor grid so admins can eyeball alignment in the editor
        // and waiters/hosts get a sense of scale. Pure CSS, no asset.
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      >
        {!editable && isZoomed && (
          <button
            type="button"
            onClick={resetZoom}
            className="absolute top-2 right-2 z-20 px-2.5 py-1.5 rounded-full bg-gray-900/80 backdrop-blur text-xs font-semibold text-white border border-white/10 shadow-lg active:scale-95"
            title="Reset zoom"
          >
            {Math.round(userZoom.scale * 100)}% • Reset
          </button>
        )}
        <div
          className={editable ? 'contents' : 'absolute inset-0'}
          style={
            editable
              ? undefined
              : ({
                  // User pinch-zoom + pan layer wraps the auto-fit
                  // transform so hosts can zoom into busy parts of the
                  // floor without disrupting the read-only fit.
                  transform: `translate(${userZoom.tx}px, ${userZoom.ty}px) scale(${userZoom.scale})`,
                  transformOrigin: '0 0',
                  willChange: 'transform',
                } as React.CSSProperties)
          }
        >
          <div
            ref={canvasRef}
            // Editor: keep `min-w-[760px]` so the design surface has room
            // and admins can scroll horizontally on narrow viewports.
            // Read-only: fill the outer wrapper exactly so the auto-fit
            // transform below maps the layout into the visible viewport.
            className={
              editable
                ? 'relative w-full min-w-[760px] sm:min-w-0 h-full touch-pan-x touch-pan-y'
                : 'absolute inset-0 touch-none'
            }
            style={
              editable
                ? undefined
                : ({
                    transform: `translate(${viewTransform.tx}px, ${viewTransform.ty}px) scale(${viewTransform.scaleX}, ${viewTransform.scaleY})`,
                    transformOrigin: 'top left',
                    // Children read these to counter-distort their own
                    // shapes (so circles stay circles even when the
                    // wrapper is non-uniformly scaled to spread positions).
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
            onClick={(e) => {
              // Click on empty canvas deselects.
              if (editable && e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            {areas.map((a) => (
              <MemoAreaRect
                key={`a-${a.id}`}
                node={a}
                editable={editable}
                selected={selectedId === a.id}
                onSelect={() => setSelectedId(a.id)}
                onMove={handleMove}
                onResize={handleAreaResize}
                onRename={handleAreaRename}
                onDelete={handleDelete}
              />
            ))}
            {tables.map((t) => (
              <MemoCircle
                key={`t-${t.id}`}
                node={t}
                editable={editable}
                selected={selectedId === t.id}
                onMove={handleMove}
                onClick={() => {
                  if (editable) {
                    setSelectedId(t.id);
                    return;
                  }
                  onTableClick?.(t.label);
                }}
                onDelete={() => handleDelete(t.id)}
                colorClass={colorByLabel?.[t.label]}
                badge={badgeByLabel?.[t.label] ?? undefined}
              />
            ))}
            {(!nodes || nodes.length === 0) && (
              <div className="absolute inset-0 flex items-center justify-center text-sm opacity-70 text-center px-4">
                {showToolbar
                  ? 'Empty floor — switch to Edit layout to add tables and shapes.'
                  : 'No layout yet — ask an admin to set up this area in Settings → Table Areas.'}
              </div>
            )}
            {editable && selectedId != null && (
              <Inspector
                node={(nodes || []).find((n) => n.id === selectedId) || null}
                onChange={patchNode}
                onClose={() => setSelectedId(null)}
                onDelete={(id) => {
                  handleDelete(id);
                  setSelectedId(null);
                }}
                onRelabel={handleAreaRename}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Inspector (admin-only properties panel) ----------

function Inspector({
  node,
  onChange,
  onClose,
  onDelete,
  onRelabel,
}: {
  node: FloorNode | null;
  onChange: (id: number, patch: Partial<FloorNode>) => void;
  onClose: () => void;
  onDelete: (id: number) => void;
  onRelabel: (id: number, label: string) => void;
}) {
  const [label, setLabel] = useState(node?.label ?? '');
  useEffect(() => {
    setLabel(node?.label ?? '');
  }, [node?.id, node?.label]);
  if (!node) return null;
  const isTable = isFloorTableNode(node);
  return (
    <div className="absolute top-2 right-2 w-60 bg-gray-800/95 border border-gray-700 rounded-lg shadow-xl text-sm z-30 backdrop-blur">
      <div className="px-3 py-2 border-b border-gray-700 flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide opacity-70">
          {isTable ? 'Table' : 'Shape'}
        </span>
        <span className="ml-auto" />
        <button
          type="button"
          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600"
          onClick={onClose}
          title="Close inspector"
        >
          ✕
        </button>
      </div>
      <div className="p-3 space-y-3">
        <div>
          <div className="text-xs opacity-70 mb-1">Label</div>
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
            value={label}
            placeholder={isTable ? 'T1' : '(no label)'}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => {
              const next = label.trim();
              if (isTable && !next) {
                setLabel(node.label);
                return;
              }
              if (next !== node.label) onRelabel(node.id, next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </div>
        {isTable ? (
          <>
            <div>
              <div className="text-xs opacity-70 mb-1">Shape</div>
              <div className="flex gap-1">
                {TABLE_SHAPE_PRESETS.map((p) => {
                  const active = (node.shape ?? 'circle') === p.shape;
                  return (
                    <button
                      key={p.shape}
                      type="button"
                      className={`flex-1 flex flex-col items-center gap-1 px-2 py-2 rounded border ${
                        active
                          ? 'bg-emerald-700/40 border-emerald-500'
                          : 'bg-gray-900 border-gray-700 hover:bg-gray-800'
                      }`}
                      onClick={() =>
                        onChange(node.id, {
                          shape: p.shape,
                          w: p.w,
                          h: p.h,
                        } as Partial<FloorTableNode>)
                      }
                    >
                      <ShapePreview kind="table" shape={p.shape} />
                      <span className="text-[10px] opacity-80">
                        {p.shape === 'circle'
                          ? 'Round'
                          : p.shape === 'square'
                            ? 'Square'
                            : 'Rect'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-xs opacity-70 mb-1">Seats</div>
              <input
                type="number"
                min={0}
                max={20}
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm"
                value={Number(node.seats ?? 0) || ''}
                placeholder="—"
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onChange(node.id, {
                    seats: Number.isFinite(n) && n > 0 ? n : undefined,
                  } as Partial<FloorTableNode>);
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <div className="text-xs opacity-70 mb-1">Style</div>
              <div className="grid grid-cols-4 gap-1">
                {AREA_VARIANT_PRESETS.map((p) => {
                  const active = (node.variant ?? 'rect') === p.variant;
                  return (
                    <button
                      key={p.variant}
                      type="button"
                      title={p.label}
                      className={`flex flex-col items-center gap-1 px-1 py-2 rounded border ${
                        active
                          ? 'bg-emerald-700/40 border-emerald-500'
                          : 'bg-gray-900 border-gray-700 hover:bg-gray-800'
                      }`}
                      onClick={() =>
                        onChange(node.id, {
                          variant: p.variant,
                          color: undefined,
                          w: p.w,
                          h: p.h,
                        } as Partial<FloorAreaNode>)
                      }
                    >
                      <ShapePreview kind="area" variant={p.variant} />
                      <span className="text-[9px] opacity-80 capitalize truncate w-full text-center">
                        {p.variant}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-xs opacity-70 mb-1">Color</div>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  title="Reset to default"
                  className={`w-6 h-6 rounded border ${
                    !node.color
                      ? 'border-emerald-400'
                      : 'border-gray-700 hover:border-gray-500'
                  } bg-gradient-to-br from-gray-900 to-gray-700`}
                  onClick={() =>
                    onChange(node.id, {
                      color: undefined,
                    } as Partial<FloorAreaNode>)
                  }
                />
                {SHAPE_COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    className={`w-6 h-6 rounded border ${
                      node.color === c
                        ? 'border-emerald-400'
                        : 'border-gray-700 hover:border-gray-500'
                    }`}
                    style={{ backgroundColor: c }}
                    onClick={() =>
                      onChange(node.id, {
                        color: c,
                      } as Partial<FloorAreaNode>)
                    }
                  />
                ))}
              </div>
            </div>
          </>
        )}
        <button
          type="button"
          className="w-full px-3 py-1.5 rounded bg-rose-700 hover:bg-rose-600 text-sm"
          onClick={() => onDelete(node.id)}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------- ShapePreview (icon for menus / inspector) ----------

function ShapePreview({
  kind,
  shape,
  variant,
}: {
  kind: 'table' | 'area';
  shape?: TableShape;
  variant?: AreaVariant;
}) {
  if (kind === 'table') {
    if (shape === 'square') {
      return <div className="w-5 h-5 bg-emerald-600 rounded-sm" />;
    }
    if (shape === 'rect') {
      return <div className="w-7 h-4 bg-emerald-600 rounded-sm" />;
    }
    return <div className="w-5 h-5 bg-emerald-600 rounded-full" />;
  }
  // area variant icons
  switch (variant) {
    case 'wall':
      return <div className="w-7 h-1.5 bg-gray-500 rounded-sm" />;
    case 'bar':
      return <div className="w-7 h-3 bg-amber-700 rounded-sm" />;
    case 'door':
      return (
        <div className="w-7 h-1.5 bg-gray-300 rounded-sm border border-gray-500" />
      );
    case 'plant':
      return <div className="w-4 h-4 bg-emerald-700 rounded-full" />;
    case 'pillar':
      return <div className="w-3 h-3 bg-gray-600 rounded-full" />;
    case 'window':
      return (
        <div className="w-7 h-2 bg-sky-300/80 rounded-sm border border-sky-500" />
      );
    case 'stairs':
      return (
        <div className="w-7 h-4 bg-gray-500 rounded-sm flex flex-col justify-around p-[1px]">
          <div className="h-[1px] bg-gray-300" />
          <div className="h-[1px] bg-gray-300" />
          <div className="h-[1px] bg-gray-300" />
        </div>
      );
    case 'rect':
    default:
      return (
        <div className="w-7 h-4 border border-emerald-500 bg-transparent rounded-sm" />
      );
  }
}

// ---------- AreaRect ----------

function AreaRect({
  node,
  editable,
  selected,
  onSelect,
  onMove,
  onResize,
  onRename,
  onDelete,
}: {
  node: FloorAreaNode;
  editable: boolean;
  selected?: boolean;
  onSelect?: () => void;
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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.w}px`;
    el.style.height = `${node.h}px`;
  }, [node.x, node.y, node.w, node.h]);

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
        // ignore
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
  const styling = areaVariantStyling(variant, fill, !!editable, !!selected);
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
        // Counter-scale via CSS variables set on the parent so shapes
        // stay proportional even when the parent applies a non-uniform
        // auto-fit scale to spread positions across the canvas.
        transform:
          'translate(-50%, -50%) scale(var(--floor-cx, 1), var(--floor-cy, 1))',
        transformOrigin: 'center',
      }}
      onClick={(e) => {
        if (Date.now() < suppressClickUntilRef.current) {
          e.preventDefault();
          e.stopPropagation();
        } else if (editable) {
          onSelect?.();
        }
      }}
      onDoubleClick={() => {
        if (!editable) return;
        setRenaming(true);
      }}
      title={editable ? 'Double click to rename' : undefined}
    >
      {/* Decorative inner texture per variant. */}
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

      {(variant === 'rect' || variant === 'bar' || node.label) && (
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

// Map an area variant + fill colour to the wrapper's class + inline
// style. We use inline styles for the colours so the saved palette
// works without configuring Tailwind safelists.
function areaVariantStyling(
  variant: AreaVariant,
  fill: string,
  editable: boolean,
  selected: boolean,
): { className: string; style: React.CSSProperties } {
  const ring = selected
    ? 'ring-2 ring-emerald-400'
    : editable
      ? 'ring-1 ring-white/10'
      : '';
  switch (variant) {
    case 'wall':
      return {
        className: `rounded-sm ${ring}`,
        style: { backgroundColor: fill || '#1f2937' },
      };
    case 'bar':
      return {
        className: `rounded-md shadow-inner ${ring}`,
        style: {
          backgroundImage: `linear-gradient(180deg, ${fill || '#92400e'} 0%, rgba(0,0,0,0.25) 100%)`,
          backgroundColor: fill || '#92400e',
        },
      };
    case 'door':
      return {
        className: `rounded-sm ${ring}`,
        style: {
          backgroundColor: fill || '#9ca3af',
          opacity: 0.85,
        },
      };
    case 'plant':
      return {
        className: `rounded-full shadow ${ring}`,
        style: { backgroundColor: fill || '#15803d' },
      };
    case 'pillar':
      return {
        className: `rounded-full shadow-md ${ring}`,
        style: { backgroundColor: fill || '#374151' },
      };
    case 'window':
      return {
        className: `rounded-sm ${ring}`,
        style: {
          backgroundColor: fill || '#7dd3fc',
          opacity: 0.8,
        },
      };
    case 'stairs':
      return {
        className: `rounded-sm ${ring}`,
        style: {
          backgroundColor: fill || '#4b5563',
        },
      };
    case 'rect':
    default:
      return {
        className: `border-2 border-emerald-500 bg-transparent rounded ${ring}`,
        style: fill ? { backgroundColor: fill, opacity: 0.25 } : {},
      };
  }
}

const MemoAreaRect = memo(AreaRect);

// ---------- DraggableCircle (table) ----------

function Circle({
  node,
  editable,
  selected,
  onMove,
  onClick,
  onDelete,
  colorClass,
  badge,
}: {
  node: FloorTableNode;
  editable: boolean;
  selected?: boolean;
  onMove: (id: number, x: number, y: number) => void;
  onClick?: () => void;
  onDelete?: () => void;
  colorClass?: string;
  badge?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
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

  const shape: TableShape = node.shape ?? 'circle';
  const w = Math.max(36, Number(node.w) || (shape === 'rect' ? 100 : 64));
  const h = Math.max(36, Number(node.h) || (shape === 'rect' ? 56 : 64));
  const radius =
    shape === 'circle' ? '9999px' : shape === 'square' ? '10px' : '12px';
  const ring = selected
    ? 'ring-2 ring-emerald-300 ring-offset-2 ring-offset-gray-900'
    : '';
  return (
    // Outer wrapper sized to the table; allows the floating delete
    // button to overflow past the table edge without being clipped.
    <div
      ref={ref}
      className={`absolute ${editable ? 'cursor-move' : 'cursor-pointer'} select-none`}
      style={{
        left: pos.x,
        top: pos.y,
        width: w,
        height: h,
        touchAction: 'none' as any,
        willChange: editable ? ('transform,left,top' as any) : undefined,
        // Counter-scale via CSS variables set on the parent so shapes
        // stay proportional even when the parent applies a non-uniform
        // auto-fit scale to spread positions across the canvas.
        transform:
          'translate(-50%, -50%) scale(var(--floor-cx, 1), var(--floor-cy, 1))',
        transformOrigin: 'center',
      }}
      onClick={() => {
        if (Date.now() < suppressClickUntilRef.current) return;
        onClickRef.current?.();
      }}
      title={node.seats ? `${node.label} · seats ${node.seats}` : node.label}
    >
      {/* Inner surface holds the colored background, label and seats —
          everything that should be clipped to the table's shape stays
          inside this layer. */}
      <div
        className={`relative w-full h-full ${colorClass || GREEN} flex items-center justify-center shadow-lg overflow-hidden ${ring}`}
        style={{ borderRadius: radius }}
      >
        <div className="flex flex-col items-center leading-none px-1">
          <span className="text-sm font-semibold">{node.label}</span>
          {badge && (
            <span className="mt-0.5 text-[10px] font-semibold px-1 rounded bg-black/40 max-w-[80px] truncate">
              {badge}
            </span>
          )}
        </div>
        {/* Capacity badge — bottom-right, hidden when a status badge
            is overriding it. */}
        {node.seats && !badge && (
          <span className="absolute bottom-0.5 right-1 text-[10px] font-semibold opacity-80">
            {node.seats}
          </span>
        )}
      </div>
      {/* Floating delete button — sits OUTSIDE the clipped surface so
          it always reads as a small red circle hanging off the table's
          top-right corner. Width/height are pinned in inline styles
          (instead of relying on Tailwind w-/h-) so user-agent button
          padding can never stretch it into an oval. */}
      {editable && onDelete && (
        <button
          type="button"
          aria-label="Delete table"
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
            onDelete();
          }}
          title="Delete table"
        >
          ✕
        </button>
      )}
    </div>
  );
}

const MemoCircle = memo(Circle);
