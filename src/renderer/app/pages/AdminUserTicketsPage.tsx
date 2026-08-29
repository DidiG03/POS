import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { describeTicketNote } from '@shared/utils/transferNote';

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
  const history = describeTicketNote(note).history;
  if (history.length) {
    tooltipParts.push(...history);
  } else if (transfer) {
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

function fmtInt(n: number): string {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function SummaryTile({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string | number;
  tone?: 'slate' | 'green' | 'amber' | 'rose' | 'indigo';
}) {
  const toneCls =
    tone === 'green'
      ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-100'
      : tone === 'amber'
        ? 'border-amber-700/60 bg-amber-950/30 text-amber-100'
        : tone === 'rose'
          ? 'border-rose-700/60 bg-rose-950/30 text-rose-100'
          : tone === 'indigo'
            ? 'border-indigo-700/60 bg-indigo-950/30 text-indigo-100'
            : 'border-gray-700 bg-gray-900/50 text-gray-100';
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneCls}`}>
      <div className="text-[11px] uppercase tracking-wide opacity-70">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function TicketCard({
  ticket,
  prefs,
  computeServiceCharge,
  zoom,
  mode,
}: {
  ticket: Ticket;
  prefs: Preferences | null;
  computeServiceCharge: (base: number, p: Preferences | null) => number;
  zoom: number;
  mode: 'list' | 'grid';
}) {
  const liveItems = ticket.items.filter((it) => !it.voided);
  const voidedItems = ticket.items.filter((it) => it.voided);
  const isVoided = ((ticket.status as TicketStatus) || 'PAID') === 'VOIDED';
  const isTransferred =
    ((ticket.status as TicketStatus) || 'PAID') === 'TRANSFERRED';
  const visibleLive = mode === 'grid' ? liveItems.slice(0, 8) : liveItems;
  const hiddenLive = Math.max(0, liveItems.length - visibleLive.length);
  const table = `${ticket.area} ${ticket.tableLabel}`.trim();
  const cardTone = isVoided
    ? 'border-rose-800/70 bg-rose-950/20'
    : isTransferred || ticketHasTransfer(ticket)
      ? 'border-indigo-700/70 bg-indigo-950/20'
      : 'border-gray-700 bg-gray-800/80';

  return (
    <article
      className={`rounded-xl border p-3 shadow-sm ${cardTone}`}
      style={
        mode === 'grid'
          ? { transform: `scale(${zoom})`, transformOrigin: 'top left' }
          : undefined
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-base font-semibold">{table || 'Table —'}</div>
            <StatusBadge status={ticket.status} />
            <TransferredChip transfer={ticket.transfer} note={ticket.note} />
          </div>
          <div className="mt-0.5 text-xs text-gray-400">
            {new Date(ticket.createdAt).toLocaleString()} · Covers:{' '}
            {ticket.covers ?? '—'}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="text-xl font-bold tabular-nums">
            {fmtInt(
              ticket.subtotal +
                (prefs?.vatEnabled !== false ? ticket.vat : 0) +
                computeServiceCharge(
                  ticket.subtotal +
                    (prefs?.vatEnabled !== false ? ticket.vat : 0),
                  prefs,
                ),
            )}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-gray-500">
            Total
          </div>
        </div>
      </div>

      {(() => {
        const { history, userNote } = describeTicketNote(ticket.note);
        if (!history.length && !userNote) return null;
        return (
          <div className="mt-3 rounded-lg border border-gray-700/70 bg-gray-950/30 px-3 py-2 text-xs text-gray-300 space-y-1">
            {history.map((line, i) => (
              <div key={`${line}-${i}`}>{line}</div>
            ))}
            {userNote ? <div>Note: {userNote}</div> : null}
          </div>
        );
      })()}

      <div className="mt-3 space-y-1.5">
        {visibleLive.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-700 px-3 py-3 text-sm text-gray-400">
            No active items on this ticket.
          </div>
        ) : (
          visibleLive.map((it, i) => (
            <div
              key={`${it.name}-${i}`}
              className="flex items-start justify-between gap-3 rounded-lg border border-gray-700/70 bg-gray-900/70 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium">
                  {it.name}{' '}
                  <span className="text-gray-400 tabular-nums">×{it.qty}</span>
                </div>
                {it.note ? (
                  <div className="mt-0.5 text-xs text-gray-400">{it.note}</div>
                ) : null}
              </div>
              <div className="shrink-0 font-mono tabular-nums">
                {fmtInt(it.unitPrice * it.qty)}
              </div>
            </div>
          ))
        )}
        {hiddenLive > 0 && (
          <div className="px-3 py-1 text-xs text-gray-400">
            +{hiddenLive} more active items…
          </div>
        )}
        {voidedItems.length > 0 && (
          <details className="rounded-lg border border-rose-900/50 bg-rose-950/10 px-3 py-2 text-sm">
            <summary className="cursor-pointer text-rose-200">
              {voidedItems.length} voided item
              {voidedItems.length === 1 ? '' : 's'}
            </summary>
            <div className="mt-2 space-y-1">
              {voidedItems.map((it, i) => (
                <div
                  key={`${it.name}-${i}`}
                  className="flex justify-between gap-3 text-xs text-rose-100/75 line-through"
                >
                  <span>
                    {it.name} ×{it.qty}
                  </span>
                  <span className="font-mono tabular-nums">
                    {fmtInt(it.unitPrice * it.qty)}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <TicketTotalsRow
        ticket={ticket}
        prefs={prefs}
        computeServiceCharge={computeServiceCharge}
        layout={mode === 'list' ? 'inline' : 'stack'}
      />
    </article>
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
  const [view, setView] = useState<'list' | 'grid4'>('list');
  const [zoom, setZoom] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'ALL'>('ALL');

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

  const filteredTickets = useMemo(() => {
    if (statusFilter === 'ALL') return tickets;
    return tickets.filter(
      (t) => ((t.status as TicketStatus) || 'PAID') === statusFilter,
    );
  }, [statusFilter, tickets]);

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
              Grid
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

      <div className="rounded-xl border border-gray-700 bg-gray-800/70 p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
          <SummaryTile label="Tickets" value={tickets.length} />
          <SummaryTile label="Paid" value={totals.counts.PAID} tone="green" />
          <SummaryTile
            label="Active"
            value={totals.counts.ACTIVE}
            tone="amber"
          />
          <SummaryTile
            label="Voided"
            value={totals.counts.VOIDED}
            tone="rose"
          />
          <SummaryTile
            label="Transferred"
            value={totals.counts.TRANSFERRED}
            tone="indigo"
          />
          <SummaryTile label="Total" value={fmtInt(totals.grand)} />
        </div>
        <div className="mt-3 flex flex-col gap-3 border-t border-gray-700/70 pt-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {(['ALL', 'PAID', 'ACTIVE', 'VOIDED', 'TRANSFERRED'] as const).map(
              (s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide ${
                    statusFilter === s
                      ? 'border-blue-500 bg-blue-900/50 text-blue-100'
                      : 'border-gray-700 bg-gray-900/60 text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {s === 'ALL' ? 'All' : s.toLowerCase().replace('_', ' ')}
                  <span className="ml-2 font-mono">
                    {s === 'ALL' ? tickets.length : totals.counts[s]}
                  </span>
                </button>
              ),
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-300">
            <span>Subtotal: {fmtInt(totals.subtotal)}</span>
            <span>
              VAT:{' '}
              {prefs?.vatEnabled !== false ? (
                fmtInt(totals.vat)
              ) : (
                <span className="opacity-70">Disabled</span>
              )}
            </span>
            {prefs?.serviceCharge?.enabled && totals.serviceCharge > 0 && (
              <span>Service: {fmtInt(totals.serviceCharge)}</span>
            )}
            {totals.transfers > 0 && (
              <span title="Tickets this waiter received via a table transfer in this period">
                Transferred in: {totals.transfers}
              </span>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="opacity-70 text-sm">Loading…</div>
      ) : filteredTickets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-700 bg-gray-800/50 p-6 text-sm text-gray-400">
          No tickets match this filter.
        </div>
      ) : view === 'grid4' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {filteredTickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              prefs={prefs}
              computeServiceCharge={computeServiceCharge}
              zoom={zoom}
              mode="grid"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              prefs={prefs}
              computeServiceCharge={computeServiceCharge}
              zoom={zoom}
              mode="list"
            />
          ))}
        </div>
      )}
    </div>
  );
}
