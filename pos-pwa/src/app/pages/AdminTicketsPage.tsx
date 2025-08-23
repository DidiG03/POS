import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';

type Row = { id: number; name: string; active: boolean; tickets: number };

export default function AdminTicketsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [range, setRange] = useState<'today' | 'yesterday' | 'last7' | 'last30' | 'custom'>('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  async function load() {
    let startIso: string | undefined;
    let endIso: string | undefined;
    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (range === 'today') {
      startIso = startOfDay(now).toISOString();
      endIso = new Date().toISOString();
    } else if (range === 'yesterday') {
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      startIso = startOfDay(y).toISOString();
      endIso = startOfDay(now).toISOString();
    } else if (range === 'last7') {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      startIso = d.toISOString();
      endIso = now.toISOString();
    } else if (range === 'last30') {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      startIso = d.toISOString();
      endIso = now.toISOString();
    } else if (range === 'custom') {
      startIso = customStart ? new Date(customStart).toISOString() : undefined;
      endIso = customEnd ? new Date(customEnd).toISOString() : undefined;
    }
    const data = await api.admin.listTicketCounts({ startIso, endIso });
    setRows(data);
  }

  useEffect(() => {
    load();
  }, [range]);


  const filtered = rows
    .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.tickets - a.tickets);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          placeholder="Search staff"
          className="bg-gray-700 rounded px-3 py-2"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="bg-gray-700 rounded px-3 py-2"
          value={range}
          onChange={(e) => setRange(e.target.value as any)}
        >
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="last7">Last 7 days</option>
          <option value="last30">Last 30 days</option>
          <option value="custom">Custom</option>
        </select>
        {range === 'custom' && (
          <>
            <input type="date" className="bg-gray-700 rounded px-3 py-2" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            <input type="date" className="bg-gray-700 rounded px-3 py-2" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
            <button className="px-3 py-2 rounded bg-gray-700" onClick={load}>Apply</button>
          </>
        )}
      </div>
      <div className="bg-gray-800 rounded p-4">
        <div className="text-sm opacity-70 mb-2">Tickets by staff</div>
        <div className="space-y-2">
          {filtered.map((r) => (
            <button
              key={r.id}
              className="w-full bg-gray-700 rounded px-3 py-2 flex items-center justify-between"
              onClick={async () => {
                const { startIso, endIso } = await computeRange(range, customStart, customEnd);
                navigate(`/admin/tickets/${r.id}?start=${encodeURIComponent(startIso || '')}&end=${encodeURIComponent(endIso || '')}&name=${encodeURIComponent(r.name)}`);
              }}
            >
              <div className="flex items-center gap-3">
                <span className={`inline-block w-2 h-2 rounded-full ${r.active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                <span>{r.name}</span>
              </div>
              <div className="flex items-center gap-2 text-sm opacity-80">
                <span>{r.tickets} tickets</span>
                <span>›</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

async function computeRange(
  range: 'today' | 'yesterday' | 'last7' | 'last30' | 'custom',
  customStart: string,
  customEnd: string,
) {
  let startIso: string | undefined;
  let endIso: string | undefined;
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (range === 'today') {
    startIso = startOfDay(now).toISOString();
    endIso = new Date().toISOString();
  } else if (range === 'yesterday') {
    const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    startIso = startOfDay(y).toISOString();
    endIso = startOfDay(now).toISOString();
  } else if (range === 'last7') {
    const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    startIso = d.toISOString();
    endIso = now.toISOString();
  } else if (range === 'last30') {
    const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    startIso = d.toISOString();
    endIso = now.toISOString();
  } else if (range === 'custom') {
    startIso = customStart ? new Date(customStart).toISOString() : undefined;
    endIso = customEnd ? new Date(customEnd).toISOString() : undefined;
  }
  return { startIso, endIso };
}


