import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';

type TicketStatus = 'PAID' | 'VOIDED' | 'ACTIVE' | 'TRANSFERRED';

type TransferInfo = {
  kind: 'MOVED' | 'OWNER';
  fromUserId: number | null;
  fromUserName: string | null;
  fromArea: string | null;
  fromLabel: string | null;
  toUserId: number | null;
  toUserName: string | null;
  byUserId: number | null;
  byUserName: string | null;
};

type Ticket = {
  id: number;
  area: string;
  tableLabel: string;
  covers: number | null;
  createdAt: string;
  items: {
    name: string;
    qty: number;
    unitPrice: number;
    vatRate?: number;
    note?: string;
    voided?: boolean;
  }[];
  note?: string | null;
  subtotal: number;
  vat: number;
  status?: TicketStatus;
  transfer?: TransferInfo | null;
};

function ticketHasTransfer(t: Pick<Ticket, 'transfer' | 'note'>): boolean {
  return Boolean(t.transfer) || /\[TRANSFER/i.test(String(t.note || ''));
}

/** Compact chip matching {@link StatusBadge}; details live in the tooltip. */
function TransferredChip({
  transfer,
  note,
}: {
  transfer?: TransferInfo | null;
  note?: string | null;
}) {
  if (!ticketHasTransfer({ transfer, note })) return null;

  const fromName = transfer?.fromUserName?.trim() || '';
  const fromTable =
    transfer?.fromArea && transfer?.fromLabel
      ? `${transfer.fromArea} ${transfer.fromLabel}`
      : [transfer?.fromArea, transfer?.fromLabel]
          .filter(Boolean)
          .join(' ')
          .trim();

  const tooltipParts: string[] = [];
  if (transfer) {
    if (fromName || fromTable) {
      tooltipParts.push(
        fromName
          ? `From ${fromName}${fromTable ? ` (${fromTable})` : ''}`
          : `From ${fromTable}`,
      );
    }
    if (transfer.kind === 'MOVED') tooltipParts.push('Table was moved');
    else tooltipParts.push('Owner changed');
    if (transfer.byUserName) tooltipParts.push(`By ${transfer.byUserName}`);
    if (transfer.toUserName?.trim())
      tooltipParts.push(`To ${transfer.toUserName.trim()}`);
  } else {
    const line =
      String(note || '')
        .split('\n')
        .find((l) => /\[\s*TRANSFER\s*\]/i.test(l)) || String(note || '');
    tooltipParts.push(line.trim().slice(0, 300));
  }

  const title =
    tooltipParts.filter(Boolean).join(' • ') || 'Transferred ticket';

  return (
    <span
      className="inline-flex items-center text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border bg-indigo-900/60 border-indigo-700 text-indigo-100"
      title={title}
    >
      Transferred
    </span>
  );
}

function StatusBadge({ status }: { status?: TicketStatus }) {
  const s: TicketStatus = status || 'PAID';
  const cls =
    s === 'VOIDED'
      ? 'bg-red-900/60 border-red-700 text-red-100'
      : s === 'ACTIVE'
        ? 'bg-amber-900/60 border-amber-700 text-amber-100'
        : s === 'TRANSFERRED'
          ? 'bg-indigo-900/60 border-indigo-700 text-indigo-100'
          : 'bg-emerald-900/60 border-emerald-700 text-emerald-100';
  const label =
    s === 'PAID'
      ? 'Paid'
      : s === 'VOIDED'
        ? 'Voided'
        : s === 'TRANSFERRED'
          ? 'Transferred out'
          : 'Active';
  const tooltip =
    s === 'TRANSFERRED'
      ? 'This ticket was moved to another table. Revenue is counted on the destination ticket.'
      : `Status: ${label}`;
  return (
    <span
      className={`inline-flex items-center text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border ${cls}`}
      title={tooltip}
    >
      {label}
    </span>
  );
}

type Preferences = {
  vatEnabled: boolean;
  serviceCharge: {
    enabled: boolean;
    mode: 'PERCENT' | 'AMOUNT';
    value: number;
  };
};

function toDateKey(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function parseViewDate(startIso: string | undefined): Date {
  if (!startIso) return new Date();
  const d = new Date(startIso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayRangeIso(date: Date): { startIso: string; endIso: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  );
  const now = new Date();
  return {
    startIso: start.toISOString(),
    endIso: end > now ? now.toISOString() : end.toISOString(),
  };
}

function computeServiceCharge(
  baseTotal: number,
  prefs: Preferences | null,
): number {
  if (!prefs?.serviceCharge?.enabled || baseTotal <= 0) return 0;
  const v = Number(prefs.serviceCharge.value || 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (prefs.serviceCharge.mode === 'PERCENT') return (baseTotal * v) / 100;
  return v;
}

function TicketTotalsRow({
  ticket,
  prefs,
  computeServiceCharge,
  layout = 'stack',
}: {
  ticket: Ticket;
  prefs: Preferences | null;
  computeServiceCharge: (base: number, p: Preferences | null) => number;
  layout?: 'stack' | 'inline';
}) {
  const vatEnabled = prefs?.vatEnabled !== false;
  const vat = vatEnabled ? ticket.vat : 0;
  const base = ticket.subtotal + vat;
  const serviceCharge = computeServiceCharge(base, prefs);
  const total = base + serviceCharge;
  const fmt = (n: number) => n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (layout === 'inline') {
    return (
      <div className="mt-2 text-sm flex justify-end gap-4 flex-wrap">
        {vatEnabled ? (
          <div>VAT: {fmt(vat)}</div>
        ) : (
          <div>
            VAT: <span className="opacity-70">Disabled</span>
          </div>
        )}
        {prefs?.serviceCharge?.enabled && serviceCharge > 0 && (
          <div>Service: {fmt(serviceCharge)}</div>
        )}
        <div>Total: {fmt(total)}</div>
      </div>
    );
  }
  return (
    <div className="mt-2 pt-2 border-t border-gray-700 space-y-1 text-sm">
      {vatEnabled ? (
        <div className="flex justify-between opacity-80">
          <span>VAT</span>
          <span>{fmt(vat)}</span>
        </div>
      ) : (
        <div className="flex justify-between opacity-70">
          <span>VAT</span>
          <span>Disabled</span>
        </div>
      )}
      {prefs?.serviceCharge?.enabled && serviceCharge > 0 && (
        <div className="flex justify-between opacity-80">
          <span>Service charge</span>
          <span>{fmt(serviceCharge)}</span>
        </div>
      )}
      <div className="flex justify-between text-base font-bold">
        <span>Total</span>
        <span>{fmt(total)}</span>
      </div>
    </div>
  );
}

export default function AdminUserTicketsPage() {
  const { userId } = useParams();
  const [params, setParams] = useSearchParams();
  const start = params.get('start') || undefined;
  const end = params.get('end') || undefined;
  const name = params.get('name') || '';
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [view, setView] = useState<'list' | 'grid4'>('grid4');
  const [zoom, setZoom] = useState<number>(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s: any = await window.api.settings.get().catch(() => null);
        if (cancelled) return;
        const sc = s?.preferences?.serviceCharge || {};
        setPrefs({
          vatEnabled: Boolean(s?.fiscal?.enabled),
          serviceCharge: {
            enabled: Boolean(sc.enabled),
            mode:
              String(sc.mode || 'PERCENT').toUpperCase() === 'AMOUNT'
                ? 'AMOUNT'
                : 'PERCENT',
            value: Number(sc.value ?? 10),
          },
        });
      } catch {
        if (!cancelled) setPrefs(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const viewDate = parseViewDate(start);
  const today = new Date();
  const isToday = viewDate.toDateString() === today.toDateString();

  function goToDate(d: Date) {
    const { startIso, endIso } = dayRangeIso(d);
    const next = new URLSearchParams(params);
    next.set('start', startIso);
    next.set('end', endIso);
    setParams(next);
  }

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      const data = await window.api.admin.listTicketsByUser(Number(userId), {
        startIso: start,
        endIso: end,
      });
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
    const vatEnabled = prefs?.vatEnabled !== false;
    let subtotal = 0;
    let vat = 0;
    let serviceCharge = 0;
    let transfers = 0;
    const counts: Record<TicketStatus, number> = {
      PAID: 0,
      ACTIVE: 0,
      VOIDED: 0,
      TRANSFERRED: 0,
    };
    for (const t of tickets) {
      const s: TicketStatus = (t.status as TicketStatus) || 'PAID';
      counts[s] += 1;
      // TRANSFERRED rows are snapshots of a session that moved to
      // another table — the destination row in the same list already
      // contributes the money, so we deliberately leave their
      // subtotal / vat / service charge out of the period totals.
      if (s !== 'TRANSFERRED') {
        subtotal += t.subtotal;
        vat += vatEnabled ? t.vat : 0;
        const base = t.subtotal + (vatEnabled ? t.vat : 0);
        serviceCharge += computeServiceCharge(base, prefs);
      }
      if (ticketHasTransfer(t)) transfers += 1;
    }
    const grand = subtotal + vat + serviceCharge;
    return { subtotal, vat, serviceCharge, grand, counts, transfers };
  }, [tickets, prefs]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div className="text-lg font-semibold min-w-0 truncate">
          {name ? `${name}'s Tickets` : 'User Tickets'}
        </div>
        <div className="flex items-center gap-2 justify-center">
          <button
            type="button"
            className="w-8 h-8 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center"
            onClick={() =>
              goToDate(new Date(viewDate.getTime() - 24 * 60 * 60 * 1000))
            }
            aria-label="Previous day"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="pos-icon"
            >
              <path
                d="M15 18l-6-6 6-6"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <input
            type="date"
            value={toDateKey(viewDate)}
            onChange={(e) => {
              const v = e.target.value;
              if (v) {
                const [y, m, d] = v.split('-').map(Number);
                goToDate(new Date(y, m - 1, d));
              }
            }}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-700"
            title="Click to change date"
          />
          <button
            type="button"
            className="w-8 h-8 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() =>
              goToDate(new Date(viewDate.getTime() + 24 * 60 * 60 * 1000))
            }
            disabled={isToday}
            aria-label="Next day"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="pos-icon"
            >
              <path
                d="M9 18l6-6-6-6"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2 justify-end">
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
            <button
              className="px-2 py-1"
              onClick={() =>
                setZoom((z) => Math.max(0.8, Math.round((z - 0.1) * 10) / 10))
              }
            >
              A−
            </button>
            <div className="px-2 opacity-80">{Math.round(zoom * 100)}%</div>
            <button
              className="px-2 py-1"
              onClick={() =>
                setZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))
              }
            >
              A+
            </button>
          </div>
          <Link
            to="/admin/tickets"
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-sm"
          >
            Back
          </Link>
        </div>
      </div>

      <div className="bg-gray-800 rounded p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div>Tickets: {tickets.length.toLocaleString()}</div>
        <div className="flex items-center gap-2">
          <StatusBadge status="PAID" />
          <span>{totals.counts.PAID}</span>
          <StatusBadge status="ACTIVE" />
          <span>{totals.counts.ACTIVE}</span>
          <StatusBadge status="VOIDED" />
          <span>{totals.counts.VOIDED}</span>
          {totals.counts.TRANSFERRED > 0 && (
            <>
              <StatusBadge status="TRANSFERRED" />
              <span>{totals.counts.TRANSFERRED}</span>
            </>
          )}
        </div>
        {totals.transfers > 0 && (
          <div
            className="flex items-center gap-2"
            title="Tickets this waiter received via a table transfer in this period"
          >
            <span className="inline-flex items-center text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border bg-indigo-900/60 border-indigo-700 text-indigo-100">
              Transferred in
            </span>
            <span>{totals.transfers}</span>
          </div>
        )}
        <div>
          Subtotal:{' '}
          {totals.subtotal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
        </div>
        {prefs?.vatEnabled !== false ? (
          <div>
            VAT: {totals.vat.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          </div>
        ) : (
          <div>
            VAT: <span className="opacity-70">Disabled</span>
          </div>
        )}
        {prefs?.serviceCharge?.enabled && totals.serviceCharge > 0 && (
          <div>
            Service charge:{' '}
            {totals.serviceCharge
              .toFixed(0)
              .replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          </div>
        )}
        <div>
          Total: {totals.grand.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
        </div>
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
              <div
                key={t.id}
                className={`bg-gray-900 rounded border p-3 flex flex-col shadow-sm ${ticketHasTransfer(t) ? 'border-indigo-700 ring-1 ring-indigo-900/40' : 'border-gray-700'}`}
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              >
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <div className="text-sm font-semibold whitespace-nowrap">
                      {new Date(t.createdAt).toLocaleTimeString()}
                    </div>
                    <StatusBadge status={t.status} />
                    <TransferredChip transfer={t.transfer} note={t.note} />
                  </div>
                  <div className="text-xs opacity-80 whitespace-nowrap">
                    {t.area} • {t.tableLabel} • C:{t.covers ?? '—'}
                  </div>
                </div>
                <div className="font-mono tabular-nums text-[13px] md:text-sm leading-snug flex-1">
                  {items.map((it, i) => (
                    <div
                      key={i}
                      className={`px-2 py-0.5 rounded flex items-center justify-between ${it.voided ? 'bg-red-900/50 line-through' : 'bg-gray-800'}`}
                    >
                      <div className="min-w-0 truncate" title={it.name}>
                        {it.name} ×{it.qty}
                        {it.note ? ` • ${it.note}` : ''}
                      </div>
                      <div className="ml-2 shrink-0">
                        {it.unitPrice * it.qty}
                      </div>
                    </div>
                  ))}
                  {extra > 0 && (
                    <div className="mt-1 text-xs opacity-70">
                      +{extra} more…
                    </div>
                  )}
                </div>
                {t.note && (
                  <div className="mt-2 text-xs opacity-80">Note: {t.note}</div>
                )}
                <TicketTotalsRow
                  ticket={t}
                  prefs={prefs}
                  computeServiceCharge={computeServiceCharge}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <div
              key={t.id}
              className={`bg-gray-800 rounded p-3 ${ticketHasTransfer(t) ? 'border border-indigo-700' : ''}`}
            >
              <div className="text-sm opacity-80 mb-1 flex items-center gap-2 flex-wrap">
                <StatusBadge status={t.status} />
                <TransferredChip transfer={t.transfer} note={t.note} />
                <span>
                  {new Date(t.createdAt).toLocaleString()} • {t.area} •{' '}
                  {t.tableLabel} • Covers: {t.covers ?? '—'}
                </span>
              </div>
              <div className="space-y-1 text-sm">
                {t.items.map((it, i) => (
                  <div
                    key={i}
                    className={`flex justify-between ${it.voided ? 'opacity-60 line-through' : ''}`}
                  >
                    <div>
                      <span className="font-medium">{it.name}</span>
                      <span className="opacity-70"> ×{it.qty}</span>
                      {it.note ? (
                        <span className="opacity-70"> • {it.note}</span>
                      ) : null}
                      {it.voided ? (
                        <span className="ml-2 text-[10px] px-1 rounded bg-red-700">
                          VOID
                        </span>
                      ) : null}
                    </div>
                    <div>{it.unitPrice * it.qty}</div>
                  </div>
                ))}
              </div>
              {t.note && (
                <div className="text-xs opacity-70 mt-1">Note: {t.note}</div>
              )}
              <TicketTotalsRow
                ticket={t}
                prefs={prefs}
                computeServiceCharge={computeServiceCharge}
                layout="inline"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
