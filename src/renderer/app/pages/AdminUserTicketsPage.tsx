import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';

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
  const [view, setView] = useState<'list' | 'grid4'>('grid4');
  const [zoom, setZoom] = useState<number>(1);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      const data = await window.api.admin.listTicketsByUser(Number(userId), { startIso: start, endIso: end });
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
          <div className="bg-gray-800 rounded overflow-hidden text-xs flex items-center">
            <button className="px-2 py-1" onClick={() => setZoom((z) => Math.max(0.8, Math.round((z - 0.1) * 10) / 10))}>A−</button>
            <div className="px-2 opacity-80">{Math.round(zoom * 100)}%</div>
            <button className="px-2 py-1" onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))}>A+</button>
          </div>
          <Link to="/admin/tickets" className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-sm">Back</Link>
        </div>
      </div>

      <div className="bg-gray-800 rounded p-3 flex gap-6 text-sm">
        <div>Tickets: {tickets.length.toLocaleString()}</div>
        <div>Subtotal: {totals.subtotal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</div>
        <div>VAT: {totals.vat.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</div>
        <div>Total: {totals.grand.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</div>
      </div>

      {loading ? (
        <div className="opacity-70 text-sm">Loading…</div>
      ) : view === 'grid4' ? (
        <div className="grid grid-cols-4 gap-3">
          {tickets.map((t) => {
            const maxLines = 10;
            const extra = Math.max(0, t.items.length - maxLines);
            const items = t.items.slice(0, maxLines);
            return (
              <div key={t.id} className="bg-gray-900 rounded border border-gray-700 p-3 flex flex-col shadow-sm" style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold">{new Date(t.createdAt).toLocaleTimeString()}</div>
                  <div className="text-xs opacity-80">{t.area} • {t.tableLabel} • C:{t.covers ?? '—'}</div>
                </div>
                <div className="font-mono tabular-nums text-[13px] md:text-sm leading-snug flex-1">
                  {items.map((it, i) => (
                    <div key={i} className={`px-2 py-0.5 rounded flex items-center justify-between ${it.voided ? 'bg-red-900/50 line-through' : 'bg-gray-800'}`}>
                      <div className="min-w-0 truncate" title={it.name}>
                        {it.name} ×{it.qty}{it.note ? ` • ${it.note}` : ''}
                      </div>
                      <div className="ml-2 shrink-0">{(it.unitPrice * it.qty)}</div>
                    </div>
                  ))}
                  {extra > 0 && (
                    <div className="mt-1 text-xs opacity-70">+{extra} more…</div>
                  )}
                </div>
                {t.note && <div className="mt-2 text-xs opacity-80">Note: {t.note}</div>}
                <div className="mt-2 pt-2 border-t border-gray-700 flex items-center justify-between text-sm">
                  <div className="opacity-80">VAT: {t.vat}</div>
                  <div className="text-base font-bold">Total {(t.subtotal + t.vat)}</div>
                </div>
              </div>
            );
          })}
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
                    <div>{(it.unitPrice * it.qty)}</div>
                  </div>
                ))}
              </div>
              {t.note && <div className="text-xs opacity-70 mt-1">Note: {t.note}</div>}
              <div className="mt-2 text-sm flex justify-end gap-4">
                <div>VAT: {t.vat}</div>
                <div>Total: {(t.subtotal + t.vat)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


