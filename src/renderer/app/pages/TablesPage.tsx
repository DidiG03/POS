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

export default function TablesPage() {
  const [area, setArea] = useState<string>('Main Hall');
  const [areas, setAreas] = useState<{ name: string; count: number }[]>([]);
  const { user } = useSessionStore();
  const [editable, setEditable] = useState(false);
  const [nodes, setNodes] = useState<TableNode[] | null>(null);
  const { setSelectedTable, pendingAction, setPendingAction } = useOrderContext();
  const navigate = useNavigate();
  const { isOpen } = useTableStatus();
  const { hydrate, clear } = useTicketStore();

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
    const baseLabel = areaName[0]?.toUpperCase() ?? 'T';
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
        setNodes(saved);
      } else {
        setNodes(generateDefaultNodes(area, targetCount));
      }
    })();
  }, [user, area, areas]);

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
      </div>

      <div className="flex items-center justify-between">
        <Legend />
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
            colorClass={isOpen(area, t.label) ? RED : GREEN}
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

function Legend() {
  return (
    <div className="flex gap-3 text-sm opacity-80">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-3 h-3 rounded-full ${GREEN}`} />
        <span>Free</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`inline-block w-3 h-3 rounded-full ${RED}`} />
        <span>Has ticket</span>
      </div>
    </div>
  );
}

function DraggableCircle({ node, editable, onMove, onClick, colorClass }: { node: TableNode; editable: boolean; onMove: (x: number, y: number) => void; onClick?: () => void; colorClass?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
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

  return (
    <div
      ref={ref}
      className={`absolute -translate-x-1/2 -translate-y-1/2 w-16 h-16 ${colorClass || GREEN} rounded-full flex items-center justify-center shadow-lg ${editable ? 'cursor-move' : 'cursor-pointer'} select-none`}
      style={{ left: node.x, top: node.y }}
      title={`${node.label} • ${node.status}`}
      onClick={onClick}
    >
      <span className="text-sm font-semibold">{node.label}</span>
    </div>
  );
}


