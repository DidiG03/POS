import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/session';

type TrendRange = 'daily' | 'weekly' | 'monthly';

type Overview = { revenueTodayNet: number; revenueTodayVat: number; openOrders: number };

type SalesPoint = { label: string; total: number; orders: number };

export default function ReportsPage() {
  const { user } = useSessionStore();
  const [loading, setLoading] = useState<boolean>(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [topSelling, setTopSelling] = useState<{ name: string; qty: number; revenue: number } | null>(null);
  const [range, setRange] = useState<TrendRange>('daily');
  const [points, setPoints] = useState<SalesPoint[]>([]);
  const [currency, setCurrency] = useState<string>('EUR');
  const [ticketLoading, setTicketLoading] = useState<boolean>(false);
  const [activeTickets, setActiveTickets] = useState<any[]>([]);
  const [activeTicketsError, setActiveTicketsError] = useState<string | null>(null);
  const [paidTickets, setPaidTickets] = useState<any[]>([]);
  const [paidTicketsError, setPaidTicketsError] = useState<string | null>(null);
  const [paidQuery, setPaidQuery] = useState<string>('');
  const [paidLimit, setPaidLimit] = useState<number>(40);
  const [ticketsApiMissing, setTicketsApiMissing] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const s = await window.api.settings.get().catch(() => null as any);
        const cur = String((s as any)?.currency || 'EUR').trim() || 'EUR';
        setCurrency(cur);
        if (!user?.id) {
          setOverview(null);
          setTopSelling(null);
          setPoints([]);
          return;
        }
        const [ov, top, trend] = await Promise.all([
          window.api.reports.getMyOverview(user.id),
          window.api.reports.getMyTopSellingToday(user.id),
          window.api.reports.getMySalesTrends({ userId: user.id, range }),
        ]);
        setOverview(ov as any);
        setTopSelling(top as any);
        setPoints((trend as any)?.points || []);
      } finally {
        setLoading(false);
      }
    })();
  }, [range, user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setActiveTickets([]);
      setPaidTickets([]);
      return;
    }
    if (ticketsApiMissing) return;
    let alive = true;
    const load = async () => {
      setTicketLoading(true);
      try {
        setActiveTicketsError(null);
        setPaidTicketsError(null);

        const [a, p] = await Promise.all([
          window.api.reports.listMyActiveTickets(user.id),
          window.api.reports.listMyPaidTickets({ userId: user.id, q: paidQuery, limit: paidLimit }),
        ]);
        if (!alive) return;
        setActiveTickets(Array.isArray(a) ? a : []);
        setPaidTickets(Array.isArray(p) ? p : []);
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        if (msg.includes("No handler registered for 'reports:listMyActiveTickets'") || msg.includes("No handler registered for 'reports:listMyPaidTickets'")) {
          setTicketsApiMissing(true);
        } else {
          // We don't know which one failed (Promise.all), show the message in both panels for visibility.
          setActiveTicketsError(msg || 'Failed to load active tickets');
          setPaidTicketsError(msg || 'Failed to load paid tickets');
        }
      } finally {
        if (alive) setTicketLoading(false);
      }
    };
    void load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [user?.id, paidQuery, paidLimit, ticketsApiMissing]);

  const fmtCurrency = useMemo(
    () => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: 2 }),
    [currency],
  );

  return (
    <div className="h-full min-h-0 overflow-auto pr-1">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Reports</h2>
        <div className="flex items-center gap-2">
          <button
            className={`px-2 py-1 rounded text-sm ${range === 'daily' ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-700'}`}
            onClick={() => setRange('daily')}
          >
            Last 14 days
          </button>
          <button
            className={`px-2 py-1 rounded text-sm ${range === 'weekly' ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-700'}`}
            onClick={() => setRange('weekly')}
          >
            12 weeks
          </button>
          <button
            className={`px-2 py-1 rounded text-sm ${range === 'monthly' ? 'bg-gray-700' : 'bg-gray-800 hover:bg-gray-700'}`}
            onClick={() => setRange('monthly')}
          >
            12 months
          </button>
        </div>
      </div>

      {loading && (
        <div className="opacity-70">Loading statistics…</div>
      )}

      {!loading && !user && (
        <div className="opacity-70">Please log in to view your statistics.</div>
      )}

      {!loading && user && overview && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          <StatCard title="Revenue (today, net)" value={fmtCurrency.format(overview.revenueTodayNet || 0)} />
          <StatCard title="VAT (today)" value={fmtCurrency.format(overview.revenueTodayVat || 0)} />
          <StatCard title="Open orders" value={String(overview.openOrders)} />
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 p-3 rounded bg-gray-800 border border-gray-700">
            <div className="font-medium mb-2">Sales trend ({range})</div>
            {points.length === 0 ? (
              <div className="opacity-70 text-sm">No data</div>
            ) : (
              <ul className="space-y-2">
                {points.map((p) => (
                  <li key={p.label} className="flex items-center justify-between text-sm">
                    <span className="opacity-80 w-16">{p.label}</span>
                    <div className="flex-1 mx-3 h-2 rounded bg-gray-700 overflow-hidden">
                      <div
                        className="h-2 bg-blue-600"
                        style={{ width: `${Math.min(100, Math.round((p.total / Math.max(1, Math.max(...points.map(x => x.total)))) * 100))}%` }}
                      />
                    </div>
                    <span className="w-28 text-right">{fmtCurrency.format(p.total)}</span>
                    <span className="w-16 text-right opacity-80">{p.orders} tkt</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="p-3 rounded bg-gray-800 border border-gray-700">
            <div className="font-medium mb-2">Top selling (today)</div>
            {!topSelling ? (
              <div className="opacity-70 text-sm">No data</div>
            ) : (
              <div className="text-sm">
                <div className="font-semibold">{topSelling.name}</div>
                <div className="opacity-80">Qty: {topSelling.qty}</div>
                <div>Revenue: {fmtCurrency.format(topSelling.revenue)}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tickets (Active + Paid) */}
      {user && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-base font-semibold">Tickets</div>
            <div className="text-xs opacity-70">
              {ticketsApiMissing ? 'Update required (restart POS)' : (ticketLoading ? 'Refreshing…' : 'Auto refresh: 15s')}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="p-3 rounded bg-gray-800 border border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">Active tickets</div>
                <div className="text-xs opacity-70">{activeTickets.length}</div>
              </div>
              {activeTicketsError && (
                <div className="mb-2 text-xs text-rose-200 bg-rose-900/30 border border-rose-800 rounded px-3 py-2">
                  Active tickets error: <span className="font-semibold">{activeTicketsError}</span>
                </div>
              )}
              {activeTickets.length === 0 ? (
                <div className="opacity-70 text-sm">No active tickets.</div>
              ) : (
                <div className="space-y-3">
                  {activeTickets.map((t: any, idx: number) => (
                    <ReceiptCard key={`${t.area}:${t.tableLabel}:${t.createdAt}:${idx}`} ticket={t} fmtCurrency={fmtCurrency} />
                  ))}
                </div>
              )}
            </div>

            <div className="p-3 rounded bg-gray-800 border border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">Paid tickets</div>
                <div className="text-xs opacity-70">{paidTickets.length}</div>
              </div>
              {paidTicketsError && (
                <div className="mb-2 text-xs text-rose-200 bg-rose-900/30 border border-rose-800 rounded px-3 py-2">
                  Paid tickets error: <span className="font-semibold">{paidTicketsError}</span>
                </div>
              )}
              <div className="flex items-center gap-2 mb-3">
                <input
                  className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                  placeholder="Search: table, waiter, item…"
                  value={paidQuery}
                  onChange={(e) => setPaidQuery(e.target.value)}
                />
                <select
                  className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                  value={String(paidLimit)}
                  onChange={(e) => setPaidLimit(Number(e.target.value))}
                >
                  <option value="20">20</option>
                  <option value="40">40</option>
                  <option value="80">80</option>
                  <option value="120">120</option>
                </select>
              </div>
              {paidTickets.length === 0 ? (
                <div className="opacity-70 text-sm">No paid tickets yet.</div>
              ) : (
                <div className="space-y-3">
                  {paidTickets.map((t: any, idx: number) => (
                    <ReceiptCard key={`${t.area}:${t.tableLabel}:${t.createdAt}:${idx}`} ticket={t} fmtCurrency={fmtCurrency} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="p-3 rounded bg-gray-800 border border-gray-700">
      <div className="text-xs opacity-70">{title}</div>
      <div className="text-lg mt-1">{value}</div>
    </div>
  );
}

function ReceiptCard({ ticket, fmtCurrency }: { ticket: any; fmtCurrency: Intl.NumberFormat }) {
  const [open, setOpen] = useState<boolean>(false);
  const items = Array.isArray(ticket?.items) ? ticket.items : [];
  const createdAt = ticket?.paidAt || ticket?.createdAt;
  const when = createdAt ? new Date(createdAt) : null;
  const headerRight = ticket?.kind === 'PAID'
    ? `${String(ticket?.paymentMethod || 'PAID')}${when ? ` • ${when.toLocaleString()}` : ''}`
    : `${when ? when.toLocaleString() : ''}`;
  const serviceChargeAmount = Number(ticket?.serviceChargeAmount || 0);
  const hasServiceCharge = Number.isFinite(serviceChargeAmount) && serviceChargeAmount > 0;
  const discountAmount = Number(ticket?.discountAmount || 0);
  const hasDiscount = Number.isFinite(discountAmount) && discountAmount > 0;
  const discountLabel = (() => {
    const t = String(ticket?.discountType || '').toUpperCase();
    const v = ticket?.discountValue;
    if (t === 'PERCENT' && Number.isFinite(Number(v))) return `${Number(v)}%`;
    if (t === 'AMOUNT' && Number.isFinite(Number(v))) return fmtCurrency.format(Number(v));
    return null;
  })();
  const serviceLabel = (() => {
    const t = String(ticket?.serviceChargeMode || '').toUpperCase();
    const v = ticket?.serviceChargeValue;
    if (t === 'PERCENT' && Number.isFinite(Number(v))) return `${Number(v)}%`;
    return null;
  })();

  return (
    <div className="rounded border border-gray-700 bg-white text-black overflow-hidden">
      <button
        className="w-full text-left px-3 py-2 border-b border-gray-200 flex items-start justify-between gap-3"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <div className="font-semibold text-sm">
            {ticket?.area ? `${ticket.area} • ` : ''}Table {ticket?.tableLabel}
            <span className="ml-2 text-xs font-normal text-gray-600">{ticket?.kind === 'PAID' ? 'Paid' : 'Active'}</span>
          </div>
          <div className="text-xs text-gray-600">
            {ticket?.userName ? `Waiter: ${ticket.userName}` : 'Waiter: —'}
            {ticket?.covers != null ? ` • Covers: ${ticket.covers}` : ''}
          </div>
        </div>
        <div className="text-xs text-gray-600 whitespace-nowrap">{headerRight}</div>
      </button>

      {open && (
        <div className="px-3 py-2 font-mono">
          {ticket?.note ? (
            <div className="text-xs mb-2">
              <span className="font-semibold">Note:</span> {String(ticket.note)}
            </div>
          ) : null}

          <div className="border-t border-gray-200 pt-2">
            {items.length === 0 ? (
              <div className="text-xs text-gray-600">No items</div>
            ) : (
              <div className="space-y-1">
                {items.map((it: any, idx: number) => {
                  const qty = Number(it?.qty || 1);
                  const name = String(it?.name || 'Item');
                  const unit = Number(it?.unitPrice || 0);
                  const line = unit * qty;
                  return (
                    <div key={idx} className="flex items-start justify-between gap-3 text-xs">
                      <div className="flex-1">
                        <div className="flex items-baseline gap-2">
                          <div className="font-semibold">{qty}x</div>
                          <div className="break-words">{name}</div>
                        </div>
                        <div className="text-[11px] text-gray-600">{fmtCurrency.format(unit)} each</div>
                      </div>
                      <div className="whitespace-nowrap">{fmtCurrency.format(line)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 mt-2 pt-2 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-700">Subtotal</span>
              <span className="font-semibold">{fmtCurrency.format(Number(ticket?.subtotal || 0))}</span>
            </div>
            {ticket?.vatEnabled === false ? (
              <div className="flex justify-between">
                <span className="text-gray-700">VAT</span>
                <span className="opacity-70">Disabled</span>
              </div>
            ) : (
              <div className="flex justify-between">
                <span className="text-gray-700">VAT</span>
                <span className="font-semibold">{fmtCurrency.format(Number(ticket?.vat || 0))}</span>
              </div>
            )}
            {hasServiceCharge && (
              <div className="flex justify-between">
                <span className="text-gray-700">Service charge{serviceLabel ? ` (${serviceLabel})` : ''}</span>
                <span className="font-semibold">{fmtCurrency.format(serviceChargeAmount)}</span>
              </div>
            )}
            {hasDiscount && (
              <div className="flex justify-between">
                <span className="text-gray-700">Discount{discountLabel ? ` (${discountLabel})` : ''}</span>
                <span className="font-semibold">-{fmtCurrency.format(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="font-semibold">{hasDiscount ? 'Total (after discount)' : 'Total'}</span>
              <span className="font-semibold">{fmtCurrency.format(Number(ticket?.total || 0))}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
