import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { api } from '../../api';

type Ticket = {
  id: number;
  area: string;
  tableLabel: string;
  covers: number | null;
  createdAt: string;
  items: { name: string; qty: number; unitPrice: number; vatRate?: number; note?: string; voided?: boolean }[];
  note?: string | null;
  subtotal: number;
  vat: number;
};

export default function AdminUserTicketsPage() {
  const { userId } = useParams();
  const [params] = useSearchParams();
  const start = params.get('start') || undefined;
  const end = params.get('end') || undefined;
  const name = params.get('name') || '';
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'grid4'>('list');

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      const data = await api.admin.listTicketsByUser(Number(userId), { startIso: start, endIso: end });
      if (!mounted) return;
      setTickets(data as any);
      setLoading(false);
    }
    if (userId) load();
    return () => {
      mounted = false;
    };
  }, [userId, start, end]);

  const totals = useMemo(() => {
    const subtotal = tickets.reduce((s, t) => s + t.subtotal, 0);
    const vat = tickets.reduce((s, t) => s + t.vat, 0);
    const grand = subtotal + vat;
    return { subtotal, vat, grand };
  }, [tickets]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-semibold">{name ? `${name}'s Tickets` : 'User Tickets'}</div>
          <div className="text-xs opacity-70">{start ? new Date(start).toLocaleString() : '—'} → {end ? new Date(end).toLocaleString() : 'Now'}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="bg-gray-800 rounded overflow-hidden text-xs">
            <button
              className={`px-3 py-1 ${view === 'list' ? 'bg-gray-700' : ''}`}
              onClick={() => setView('list')}
            >
              List
            </button>
            <button
              className={`px-3 py-1 ${view === 'grid4' ? 'bg-gray-700' : ''}`}
              onClick={() => setView('grid4')}
            >
              Grid ×4
            </button>
          </div>
          <Link to="/admin/tickets" className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-sm">Back</Link>
        </div>
      </div>

      <div className="bg-gray-800 rounded p-3 flex gap-6 text-sm">
        <div>Tickets: {tickets.length}</div>
        <div>Subtotal: {totals.subtotal.toFixed(2)}</div>
        <div>VAT: {totals.vat.toFixed(2)}</div>
        <div>Total: {totals.grand.toFixed(2)}</div>
      </div>

      {loading ? (
        <div className="opacity-70 text-sm">Loading…</div>
      ) : view === 'grid4' ? (
        <div className="grid grid-cols-4 gap-3">
          {tickets.map((t) => (
            <div key={t.id} className="bg-gray-800 rounded p-3 flex flex-col min-h-[180px]">
              <div className="text-xs opacity-80 mb-2">
                {new Date(t.createdAt).toLocaleString()} • {t.area} • {t.tableLabel} • Covers: {t.covers ?? '—'}
              </div>
              <div className="space-y-1 text-sm flex-1">
                {t.items.map((it, i) => (
                  <div key={i} className={`rounded px-2 py-1 flex items-center justify-between ${it.voided ? 'bg-red-900/50' : 'bg-gray-700'}`}>
                    <div className="min-w-0">
                      <span className="font-medium truncate" title={it.name}>{it.name}</span>
                      <span className="opacity-70"> ×{it.qty}</span>
                      {it.note && <span className="opacity-70"> • {it.note}</span>}
                      {it.voided && <span className="ml-2 text-[10px] inline-block px-1 rounded bg-red-700">VOID</span>}
                    </div>
                    <div className="ml-2 shrink-0">{(it.unitPrice * it.qty).toFixed(2)}</div>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-xs flex justify-between">
                {t.note ? <div className="opacity-70 truncate pr-2">Note: {t.note}</div> : <span />}
                <div className="flex items-center gap-3">
                  <div>VAT: {t.vat.toFixed(2)}</div>
                  <div className="font-semibold">Total: {(t.subtotal + t.vat).toFixed(2)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <div key={t.id} className="bg-gray-800 rounded p-3">
              <div className="text-sm opacity-80 mb-1">{new Date(t.createdAt).toLocaleString()} • {t.area} • {t.tableLabel} • Covers: {t.covers ?? '—'}</div>
              <div className="space-y-1 text-sm">
                {t.items.map((it, i) => (
                  <div key={i} className={`flex justify-between ${it.voided ? 'opacity-60 line-through' : ''}`}>
                    <div>
                      <span className="font-medium">{it.name}</span>
                      <span className="opacity-70"> ×{it.qty}</span>
                      {it.note ? <span className="opacity-70"> • {it.note}</span> : null}
                      {it.voided ? <span className="ml-2 text-[10px] px-1 rounded bg-red-700">VOID</span> : null}
                    </div>
                    <div>{(it.unitPrice * it.qty).toFixed(2)}</div>
                  </div>
                ))}
              </div>
              {t.note && <div className="text-xs opacity-70 mt-1">Note: {t.note}</div>}
              <div className="mt-2 text-sm flex justify-end gap-4">
                <div>VAT: {t.vat.toFixed(2)}</div>
                <div>Total: {(t.subtotal + t.vat).toFixed(2)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


