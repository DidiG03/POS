import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminSessionStore } from '../../stores/adminSession';
import { computeDateRange, type DateRangePreset } from '@shared/dateRange';

type Row = { id: number; name: string; active: boolean; tickets: number };

export default function AdminTicketsPage() {
  const navigate = useNavigate();
  const me = useAdminSessionStore((s) => s.user);
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [range, setRange] = useState<DateRangePreset>('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  async function load() {
    if (!me || me.role !== 'ADMIN') {
      setRows([]);
      return;
    }
    const { startIso, endIso } = computeDateRange(range, customStart, customEnd);
    const data = await window.api.admin.listTicketCounts({ startIso, endIso });
    setRows(data);
  }

  useEffect(() => {
    void load();
  }, [me?.id, me?.role, range, customStart, customEnd]);

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
                const { startIso, endIso } = computeDateRange(range, customStart, customEnd);
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


