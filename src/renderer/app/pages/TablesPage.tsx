import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/session';
import { useOrderContext } from '../../stores/orderContext';
import { useNavigate } from 'react-router-dom';
import { useTableStatus } from '../../stores/tableStatus';
import { useTicketStore } from '../../stores/ticket';

type TableStatus = 'FREE' | 'OCCUPIED' | 'RESERVED' | 'SERVED';
type TableNode = { id: number; label: string; x: number; y: number; status: TableStatus };

const GREEN = 'bg-emerald-700';
const RED = 'bg-rose-700';
const ORANGE = 'bg-amber-700';

export default function TablesPage() {
  const [area, setArea] = useState<string>('Main Hall');
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const { user } = useSessionStore();
  const [editable, setEditable] = useState(false);
  const [nodes, setNodes] = useState<TableNode[] | null>(null);
  const { setSelectedTable, pendingAction, setPendingAction } = useOrderContext();
  const navigate = useNavigate();
  const { isOpen, openMap } = useTableStatus();
  const { hydrate, clear } = useTicketStore();

  const [userMap, setUserMap] = useState<Record<number, string>>({});
  const [initialsByTable, setInitialsByTable] = useState<Record<string, string>>({});
  const [ownerByTable, setOwnerByTable] = useState<Record<string, number>>({});

  useEffect(() => {
    (async () => {
      try {
        const users = await window.api.auth.listUsers();
        const map: Record<number, string> = {};
        for (const u of users) map[u.id] = u.displayName;
        setUserMap(map);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const s = await window.api.settings.get();
      setAreas(s.tableAreas ?? [
        { name: 'Main Hall', count: s.tableCountMainHall ?? 8 },
        { name: 'Terrace', count: s.tableCountTerrace ?? 4 },
      ]);
      if (!s.tableAreas && area !== 'Main Hall' && area !== 'Terrace') setArea('Main Hall');
    })();
  }, []);

  function generateDefaultNodes(areaName: string, count: number): TableNode[] {
    const width = 760; const height = 460; const cx = width / 2; const cy = height / 2; const radius = Math.min(cx, cy) - 60;
    // Always use 'T' prefix across all areas so we don't create multiple label schemes
    const baseLabel = 'T';
    const n = Math.max(0, count);
    return Array.from({ length: n }).map((_, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      return { id: i + 1, label: `${baseLabel}${i + 1}`, x, y, status: 'FREE' } as TableNode;
    });
  }

  // Deterministic load: prefer saved layout if it matches area count, else generate once
  useEffect(() => {
    (async () => {
      if (!user || !areas.length) return;
      const cfg = areas.find((a) => a.name === area);
      const targetCount = cfg?.count ?? 8;
      const saved = await window.api.layout.get(user.id, area);
      if (Array.isArray(saved) && saved.length === targetCount) {
        // Normalize any legacy labels like 'M1' -> 'T1' so only one layout scheme exists
        const normalized = saved.map((n: any, i: number) => {
          const match = String(n.label).match(/^(?:[^0-9]*)(\d+)$/);
          const num = match ? Number(match[1]) : i + 1;
          return { ...n, label: `T${num}` } as TableNode;
        });
        setNodes(normalized);
      } else {
        setNodes(generateDefaultNodes(area, targetCount));
      }
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
      if (!nodes || !area) return;
      const badgeUpdates: [string, string][] = [];
      const ownerUpdates: [string, number][] = [];
      await Promise.all(
        nodes.map(async (n) => {
          if (!isOpen(area, n.label)) return;
          const k = `${area}:${n.label}`;
          try {
            const data = await window.api.tickets.getLatestForTable(area, n.label);
            if (data?.userId) ownerUpdates.push([k, data.userId]);
            if (data?.userId && userMap[data.userId]) badgeUpdates.push([k, toInitials(userMap[data.userId])]);
          } catch {}
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
  }, [area, nodes, userMap, openMap]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Tables – {area}</h2>
        <div className="flex gap-2">
          {areas.map((a) => (
            <button
              key={a.name}
              className={`px-3 py-1 rounded ${area === a.name ? 'bg-gray-700' : 'bg-gray-800'}`}
              onClick={() => setArea(a.name)}
            >
              {a.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`px-3 py-1 rounded ${editable ? 'bg-amber-700' : 'bg-gray-700'}`}
            onClick={() => setEditable((v) => !v)}
          >
            {editable ? 'Editing…' : 'Edit layout'}
          </button>
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


      <div className="relative w-full h-[520px] rounded bg-gray-800 overflow-hidden">
        {/* simple grid background */}
        <div className="absolute inset-0 opacity-20" style={{
          backgroundSize: '40px 40px',
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.08) 1px, transparent 1px)'
        }} />

        {nodes?.map((t, idx) => (
          <DraggableCircle
            key={t.id}
            node={t}
            editable={editable}
            area={area}
            onMove={(x, y) =>
              setNodes((prev) =>
                prev?.map((n, i) => (i === idx ? { ...n, x, y } : n)) ?? prev,
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
                  const data = await window.api.tickets.getLatestForTable(area, t.label);
                  if (data) hydrate({ items: data.items as any, note: data.note || '' });
                  navigate('/app/order');
                })();
                return;
              }
              // If table is free, start with a clean ticket
              clear();
              navigate('/app/order');
              if (action) {
                setTimeout(() => {
                  if (action === 'send') console.log(`ticket - ${t.label} sent`);
                  if (action === 'pay') console.log(`ticket - ${t.label} paid`);
                }, 0);
              }
            }}
            colorClass={(() => {
              if (!isOpen(area, t.label)) return GREEN;
              const ownerId = ownerByTable[`${area}:${t.label}`];
              const uid = user?.id;
              if (ownerId != null && uid != null && Number(ownerId) === Number(uid)) return RED;
              return ORANGE;
            })()}
            badge={isOpen(area, t.label) ? initialsByTable[`${area}:${t.label}`] : undefined}
            ownerName={(ownerByTable[`${area}:${t.label}`] && userMap[ownerByTable[`${area}:${t.label}`]]) || undefined}
            statusText={isOpen(area, t.label) ? 'OPEN' : 'FREE'}
          />
        ))}
        {/* Sample bar counter/obstacles */}
        {area === 'Main Hall' && (
          <div className="absolute bottom-6 left-6 right-6 h-4 rounded bg-gray-700 opacity-70" title="Bar" />
        )}
      </div>
    </div>
  );
}

function DraggableCircle({ node, editable, onMove, onClick, colorClass, badge, ownerName, statusText, area }: { node: TableNode; editable: boolean; onMove: (x: number, y: number) => void; onClick?: () => void; colorClass?: string; badge?: string; ownerName?: string; statusText?: string; area?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<{ covers: number | null; firstAt: string | null; total: number } | null>(null);
  const [showTip, setShowTip] = useState(false);
  const holdTimer = useRef<any>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !editable) return;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const down = (e: MouseEvent) => {
      dragging = true;
      const rect = el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
    };
    const move = (e: MouseEvent) => {
      if (!dragging) return;
      const parent = el.parentElement!.getBoundingClientRect();
      const x = e.clientX - parent.left - offsetX + el.offsetWidth / 2;
      const y = e.clientY - parent.top - offsetY + el.offsetHeight / 2;
      onMove(Math.max(16, Math.min(parent.width - 16, x)), Math.max(16, Math.min(parent.height - 16, y)));
    };
    const up = () => (dragging = false);
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      el.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [editable, onMove]);

  // Hover / long-press tooltip
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fetchTip = async () => {
      try {
        if (!area) return;
        const t = await (window as any).api.tickets.getTableTooltip(area, node.label);
        setTooltip(t);
        setShowTip(true);
      } catch {}
    };
    const onEnter = () => { holdTimer.current = setTimeout(fetchTip, 500); };
    const onLeave = () => { clearTimeout(holdTimer.current); setShowTip(false); };
    const onDown = () => { holdTimer.current = setTimeout(fetchTip, 2000); };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('touchstart', onDown, { passive: true } as any);
    el.addEventListener('touchend', onLeave, { passive: true } as any);
    return () => {
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('touchstart', onDown as any);
      el.removeEventListener('touchend', onLeave as any);
    };
  }, [node.label]);

  return (
    <div
      ref={ref}
      className={`absolute -translate-x-1/2 -translate-y-1/2 w-16 h-16 ${colorClass || GREEN} rounded-full flex items-center justify-center shadow-lg ${editable ? 'cursor-move' : 'cursor-pointer'} select-none`}
      style={{ left: node.x, top: node.y }}
      title={`${node.label} • ${statusText || node.status}`}
      onClick={onClick}
    >
      <div className="flex flex-col items-center leading-none">
        <span className="text-sm font-semibold">{node.label}</span>
        {badge && (
          <span className="mt-0.5 text-[10px] font-semibold px-1 rounded bg-black/40">
            {badge}
          </span>
        )}
      </div>
      {showTip && tooltip && (
        <div className="absolute top-18 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs bg-black/80 text-white px-2 py-1 rounded shadow">
          {ownerName && <div>{ownerName}</div>}
          <div>Covers: {tooltip.covers ?? '-'}</div>
          <div>Since: {tooltip.firstAt ? new Date(tooltip.firstAt).toLocaleTimeString() : '-'}</div>
          <div>Total: {tooltip.total.toFixed ? tooltip.total.toFixed(2) : tooltip.total}</div>
        </div>
      )}
    </div>
  );
}


