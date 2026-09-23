import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { describeTicketNote } from '@shared/utils/transferNote';
import { formatSaleLocation } from '@shared/editionCapabilities';
import type { FiscalSaleDTO } from '@shared/ipc';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Segmented,
  Table,
  TableFrame,
  Td,
  Th,
  cn,
} from '../../components/ui';
import type { Tone } from '../../components/ui';
import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconGrid,
  IconList,
  IconMoreVertical,
  IconTicket,
} from '../../components/icons';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';
import { TicketSalePanel } from '../components/TicketSalePanel';
import { PageSpinner } from '../../components/PageSpinner';

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
  sale?: FiscalSaleDTO | null;
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
    <span title={title}>
      <Badge tone="info">Transferred</Badge>
    </span>
  );
}

const STATUS_TONE: Record<TicketStatus, Tone> = {
  PAID: 'accent',
  ACTIVE: 'warn',
  VOIDED: 'danger',
  TRANSFERRED: 'info',
};

function StatusBadge({ status }: { status?: TicketStatus }) {
  const s: TicketStatus = status || 'PAID';
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
    <span title={tooltip}>
      <Badge tone={STATUS_TONE[s]} dot>
        {label}
      </Badge>
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

/** Settled receipt total when this ticket is matched to an Order. */
function settledSaleTotal(
  ticket: Pick<Ticket, 'status' | 'sale'>,
): number | null {
  if ((ticket.status || 'PAID') !== 'PAID') return null;
  const n = Number(ticket.sale?.total);
  return Number.isFinite(n) && n > 0 ? n : null;
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
  // Line prices are tax-inclusive. `ticket.subtotal`/`ticket.vat` are the
  // net/VAT split from the server — always sum both for the goods total so
  // we match item amounts and the staff-list TOTAL, even when VAT is off
  // in settings (which only hides the VAT breakdown, not the money).
  const vatStored = Number(ticket.vat || 0);
  const goods = Number(ticket.subtotal || 0) + vatStored;
  const vatEnabled = prefs?.vatEnabled === true;
  const settled = settledSaleTotal(ticket);
  // Prefer the ledger total (includes service / discount). Only invent a
  // service charge from current prefs when no settled sale is attached.
  const serviceCharge =
    settled != null ? 0 : computeServiceCharge(goods, prefs);
  const total = settled != null ? settled : goods + serviceCharge;
  const showService =
    settled == null &&
    Boolean(prefs?.serviceCharge?.enabled) &&
    serviceCharge > 0;
  const fmt = (n: number) => n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (layout === 'inline') {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-end gap-x-5 gap-y-1 text-[12px] text-gray-400">
        {vatEnabled ? (
          <div>
            VAT <span className="tabular text-gray-200">{fmt(vatStored)}</span>
          </div>
        ) : (
          <div>
            VAT <span className="text-gray-500">Disabled</span>
          </div>
        )}
        {showService && (
          <div>
            Service{' '}
            <span className="tabular text-gray-200">{fmt(serviceCharge)}</span>
          </div>
        )}
        <div className="text-[16px]">
          Total{' '}
          <span className="tabular font-semibold text-gray-50">
            {fmt(total)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-1 border-t border-white/7 pt-3 text-[12px]">
      {vatEnabled ? (
        <div className="flex justify-between text-gray-400">
          <span>VAT</span>
          <span className="tabular text-gray-200">{fmt(vatStored)}</span>
        </div>
      ) : (
        <div className="flex justify-between text-gray-400">
          <span>VAT</span>
          <span className="text-gray-500">Disabled</span>
        </div>
      )}
      {showService && (
        <div className="flex justify-between text-gray-400">
          <span>Service charge</span>
          <span className="tabular text-gray-200">{fmt(serviceCharge)}</span>
        </div>
      )}
      <div className="flex items-baseline justify-between pt-0.5 text-[16px] font-semibold text-gray-50">
        <span>Total</span>
        <span className="tabular">{fmt(total)}</span>
      </div>
    </div>
  );
}

function fmtInt(n: number): string {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function TicketCard({
  ticket,
  prefs,
  computeServiceCharge,
  mode,
  onSaleCorrected,
  autoOpen,
}: {
  ticket: Ticket;
  prefs: Preferences | null;
  computeServiceCharge: (base: number, p: Preferences | null) => number;
  mode: 'list' | 'grid';
  onSaleCorrected?: () => void;
  autoOpen?: boolean;
}) {
  const { t } = useTranslation();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const [moreOpen, setMoreOpen] = useState(Boolean(autoOpen));
  const liveItems = ticket.items.filter((it) => !it.voided);
  const voidedItems = ticket.items.filter((it) => it.voided);
  const visibleLive = mode === 'grid' ? liveItems.slice(0, 8) : liveItems;
  const hiddenLive = Math.max(0, liveItems.length - visibleLive.length);
  const table = formatSaleLocation({
    diningFloor: hasTables,
    area: ticket.area,
    tableLabel: ticket.tableLabel,
  });

  return (
    <article
      id={autoOpen ? `ticket-${ticket.id}` : undefined}
      className={cn(
        'py-4',
        mode === 'grid' && 'md:pr-6',
        autoOpen && 'ring-1 ring-inset ring-sky-400/70',
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[14px] font-semibold tracking-tight text-gray-50">
              {table || (hasTables ? 'Table —' : 'Sale')}
            </div>
            <StatusBadge status={ticket.status} />
            {hasTables ? (
              <TransferredChip transfer={ticket.transfer} note={ticket.note} />
            ) : null}
          </div>
          <div className="mt-1 text-[12px] text-gray-400">
            <span className="tabular">
              {new Date(ticket.createdAt).toLocaleString()}
            </span>
            {hasTables ? (
              <>
                {' · Covers: '}
                <span className="tabular">{ticket.covers ?? '—'}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-start sm:justify-end">
          <IconButton
            icon={<IconMoreVertical />}
            label={t('common.viewMore')}
            onClick={() => setMoreOpen(true)}
          />
        </div>
      </div>

      {(() => {
        const { history, userNote } = describeTicketNote(ticket.note);
        const showHistory = hasTables;
        if ((showHistory ? !history.length : true) && !userNote) return null;
        return (
          <div className="pos-well mt-3 space-y-1 px-3 py-2 text-[15px] font-light leading-snug text-gray-400">
            {showHistory
              ? history.map((line, i) => <div key={`${line}-${i}`}>{line}</div>)
              : null}
            {userNote ? (
              <div className="font-light text-gray-300">Note: {userNote}</div>
            ) : null}
          </div>
        );
      })()}

      <div className="mt-3 space-y-2">
        {visibleLive.length === 0 ? (
          <EmptyState
            compact
            icon={<IconTicket />}
            title={
              hasTables
                ? 'No active items on this ticket.'
                : 'No items on this sale.'
            }
          />
        ) : (
          <TableFrame className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th numeric>Qty</Th>
                  <Th numeric>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {visibleLive.map((it, i) => (
                  <tr key={`${it.name}-${i}`}>
                    <Td>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-gray-100">
                          {it.name}
                        </div>
                        {it.note ? (
                          <div className="mt-0.5 text-[15px] font-light leading-snug text-gray-400">
                            {it.note}
                          </div>
                        ) : null}
                      </div>
                    </Td>
                    <Td numeric className="tabular">
                      {it.qty}
                    </Td>
                    <Td numeric className="tabular">
                      {fmtInt(it.unitPrice * it.qty)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )}
        {hiddenLive > 0 && (
          <div className="tabular text-[12px] text-gray-400">
            +{hiddenLive} more active items…
          </div>
        )}
        {voidedItems.length > 0 && (
          <details className="border-t border-white/[0.06] pt-2">
            <summary className="cursor-pointer text-[12px] font-medium text-rose-200">
              {voidedItems.length} voided item
              {voidedItems.length === 1 ? '' : 's'}
            </summary>
            <div className="mt-2 space-y-1">
              {voidedItems.map((it, i) => (
                <div
                  key={`${it.name}-${i}`}
                  className="flex justify-between gap-3 text-[12px] text-rose-200/80 line-through"
                >
                  <span className="truncate">
                    {it.name} ×{it.qty}
                  </span>
                  <span className="tabular shrink-0">
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

      <Modal
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title={table || (hasTables ? 'Table —' : 'Sale')}
        description={t('fiscal.salesTitle')}
        size="lg"
      >
        {ticket.sale ? (
          <TicketSalePanel
            sale={ticket.sale}
            onCorrected={() => {
              setMoreOpen(false);
              onSaleCorrected?.();
            }}
          />
        ) : (
          <p className="text-[13px] leading-relaxed text-gray-400">
            {((ticket.status as TicketStatus) || 'PAID') === 'ACTIVE'
              ? t('fiscal.salesOpenHelp')
              : t('fiscal.salesNoOrder')}
          </p>
        )}
      </Modal>
    </article>
  );
}

const STATUS_FILTERS = [
  'ALL',
  'PAID',
  'ACTIVE',
  'VOIDED',
  'TRANSFERRED',
] as const;

const STATUS_FILTER_LABEL: Record<(typeof STATUS_FILTERS)[number], string> = {
  ALL: 'All',
  PAID: 'Paid',
  ACTIVE: 'Active',
  VOIDED: 'Voided',
  TRANSFERRED: 'Transferred',
};

export default function AdminUserTicketsPage() {
  const { t } = useTranslation();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const { userId } = useParams();
  const [params, setParams] = useSearchParams();
  const wantsAllDays = params.get('all') === '1';
  const startParam = params.get('start') || undefined;
  const endParam = params.get('end') || undefined;
  // Until the URL is filled with today's range, still query today (not all days).
  const defaultDay = dayRangeIso(new Date());
  const start = wantsAllDays ? undefined : startParam || defaultDay.startIso;
  const end = wantsAllDays ? undefined : endParam || defaultDay.endIso;
  const allDays = wantsAllDays;
  const name = params.get('name') || '';
  const tableFilter = params.get('table') || '';
  const areaFilter = params.get('area') || '';
  const openTicketId = Number(params.get('ticket') || 0);
  const shouldOpen = params.get('open') === '1';
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [view, setView] = useState<'list' | 'grid4'>('list');
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'ALL'>(
    (STATUS_FILTERS as readonly string[]).includes(
      String(params.get('status') || 'ALL').toUpperCase(),
    )
      ? (String(params.get('status') || 'ALL').toUpperCase() as
          | TicketStatus
          | 'ALL')
      : 'ALL',
  );

  // Persist today's range in the URL so the date control shows today by default.
  useEffect(() => {
    if (wantsAllDays || startParam) return;
    const next = new URLSearchParams(params);
    next.set('start', defaultDay.startIso);
    next.set('end', defaultDay.endIso);
    next.delete('all');
    setParams(next, { replace: true });
  }, [
    wantsAllDays,
    startParam,
    defaultDay.startIso,
    defaultDay.endIso,
    params,
    setParams,
  ]);

  const refreshTickets = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!userId) {
        setTickets([]);
        setLoading(false);
        return;
      }
      if (!opts?.silent) setLoading(true);
      try {
        const data = await window.api.admin.listTicketsByUser(Number(userId), {
          startIso: start,
          endIso: end,
        });
        setTickets(Array.isArray(data) ? (data as Ticket[]) : []);
      } catch {
        setTickets([]);
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [userId, start, end],
  );

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
  const isToday = !allDays && viewDate.toDateString() === today.toDateString();

  function goToDate(d: Date) {
    const { startIso, endIso } = dayRangeIso(d);
    const next = new URLSearchParams(params);
    next.set('start', startIso);
    next.set('end', endIso);
    next.delete('all');
    setParams(next);
  }

  function showAllDays() {
    const next = new URLSearchParams(params);
    next.delete('start');
    next.delete('end');
    next.set('all', '1');
    setParams(next);
  }

  useEffect(() => {
    void refreshTickets();
  }, [refreshTickets]);

  const totals = useMemo(() => {
    const vatEnabled = prefs?.vatEnabled === true;
    let subtotal = 0;
    let vat = 0;
    let serviceCharge = 0;
    let grand = 0;
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
      // Period money is paid sittings only. ACTIVE (open/abandoned) and
      // VOIDED must not inflate the grand total; TRANSFERRED snapshots are
      // already counted on the destination row.
      if (s === 'PAID') {
        subtotal += t.subtotal;
        vat += Number(t.vat || 0);
        const goods = t.subtotal + Number(t.vat || 0);
        const settled = settledSaleTotal(t);
        if (settled != null) {
          grand += settled;
        } else {
          const sc = computeServiceCharge(goods, prefs);
          serviceCharge += sc;
          grand += goods + sc;
        }
      }
      if (ticketHasTransfer(t)) transfers += 1;
    }
    return {
      subtotal,
      vat,
      serviceCharge,
      grand,
      counts,
      transfers,
      /** Goods total at menu prices (tax-inclusive). */
      goods: subtotal + vat,
      vatEnabled,
    };
  }, [tickets, prefs]);

  const filteredTickets = useMemo(() => {
    return tickets.filter((t) => {
      if (
        statusFilter !== 'ALL' &&
        ((t.status as TicketStatus) || 'PAID') !== statusFilter
      ) {
        return false;
      }
      if (tableFilter && t.tableLabel !== tableFilter) return false;
      if (areaFilter && t.area !== areaFilter) return false;
      return true;
    });
  }, [statusFilter, tickets, tableFilter, areaFilter]);

  useEffect(() => {
    if (!shouldOpen || !openTicketId || loading) return;
    const id = window.setTimeout(() => {
      document.getElementById(`ticket-${openTicketId}`)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }, 50);
    return () => window.clearTimeout(id);
  }, [shouldOpen, openTicketId, loading, filteredTickets.length]);

  function clearTrace() {
    const next = new URLSearchParams(params);
    next.delete('table');
    next.delete('area');
    next.delete('ticket');
    next.delete('open');
    next.delete('status');
    next.delete('sale');
    setParams(next);
    setStatusFilter('ALL');
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 sm:space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          to="/admin/tickets"
          className="pos-icon-btn -ml-2 shrink-0"
          aria-label="Back"
          title="Back"
        >
          <IconArrowLeft />
        </Link>
        <h1 className="min-w-0 truncate text-right text-[19px] font-semibold leading-tight tracking-tight text-gray-50">
          {name
            ? `${name}'s ${hasTables ? 'Tickets' : 'Sales'}`
            : hasTables
              ? 'User Tickets'
              : 'User Sales'}
        </h1>
      </div>

      {tableFilter || areaFilter ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-gray-400">
          <span>
            {t('inbox.showingTable', {
              table: [areaFilter, tableFilter].filter(Boolean).join(' '),
            })}
          </span>
          <button
            type="button"
            className="font-medium text-sky-300 hover:text-sky-200"
            onClick={clearTrace}
          >
            {t('inbox.showAllTickets')}
          </button>
        </div>
      ) : null}

      <div className="border-y border-white/[0.06]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
          <div className="flex items-center gap-2">
            <IconButton
              label="Previous day"
              icon={<IconChevronLeft />}
              onClick={() =>
                goToDate(
                  allDays
                    ? new Date(today.getTime() - 24 * 60 * 60 * 1000)
                    : new Date(viewDate.getTime() - 24 * 60 * 60 * 1000),
                )
              }
            />
            <Input
              type="date"
              value={allDays ? '' : toDateKey(viewDate)}
              onChange={(e) => {
                const v = e.target.value;
                if (v) {
                  const [y, m, d] = v.split('-').map(Number);
                  goToDate(new Date(y, m - 1, d));
                }
              }}
              className="w-[150px] cursor-pointer"
              title="Click to change date"
            />
            <IconButton
              label="Next day"
              icon={<IconChevronRight />}
              onClick={() =>
                goToDate(new Date(viewDate.getTime() + 24 * 60 * 60 * 1000))
              }
              disabled={allDays || isToday}
            />
            {allDays ? (
              <span className="text-[12px] font-medium text-gray-400">
                All days
              </span>
            ) : (
              <button
                type="button"
                className="text-[12px] font-medium text-sky-300 hover:text-sky-200"
                onClick={showAllDays}
              >
                All days
              </button>
            )}
          </div>

          <Button
            size="sm"
            className="ml-auto"
            icon={view === 'list' ? <IconGrid /> : <IconList />}
            aria-label={view === 'list' ? 'Show grid' : 'Show list'}
            onClick={() => setView((v) => (v === 'list' ? 'grid4' : 'list'))}
          >
            {view === 'list' ? 'Grid' : 'List'}
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] py-3">
          <Segmented
            ariaLabel="Status filter"
            value={statusFilter}
            onChange={setStatusFilter}
            options={(hasTables
              ? STATUS_FILTERS
              : STATUS_FILTERS.filter((s) => s !== 'TRANSFERRED')
            ).map((s) => ({
              value: s,
              label: STATUS_FILTER_LABEL[s],
              count: s === 'ALL' ? tickets.length : totals.counts[s],
            }))}
          />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-gray-400">
            <span>
              Subtotal{' '}
              <span className="tabular text-gray-200">
                {fmtInt(totals.vatEnabled ? totals.subtotal : totals.goods)}
              </span>
            </span>
            <span>
              VAT{' '}
              {totals.vatEnabled ? (
                <span className="tabular text-gray-200">
                  {fmtInt(totals.vat)}
                </span>
              ) : (
                <span className="text-gray-500">Disabled</span>
              )}
            </span>
            {hasTables &&
              prefs?.serviceCharge?.enabled &&
              totals.serviceCharge > 0 && (
                <span>
                  Service{' '}
                  <span className="tabular text-gray-200">
                    {fmtInt(totals.serviceCharge)}
                  </span>
                </span>
              )}
            {hasTables && totals.transfers > 0 && (
              <span title="Tickets this waiter received via a table transfer in this period">
                Transferred in{' '}
                <span className="tabular text-gray-200">
                  {totals.transfers}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="admin-metrics">
        <div className="admin-metric">
          <div className="admin-metric-label">
            {hasTables ? 'Tickets' : 'Sales'}
          </div>
          <div className="admin-metric-value">{tickets.length}</div>
        </div>
        <div className="admin-metric">
          <div className="admin-metric-label">Paid</div>
          <div
            className={cn(
              'admin-metric-value',
              totals.counts.PAID === 0 ? 'is-quiet' : '!text-emerald-500',
            )}
          >
            {totals.counts.PAID}
          </div>
        </div>
        <div className="admin-metric">
          <div className="admin-metric-label">Active</div>
          <div
            className={cn(
              'admin-metric-value',
              totals.counts.ACTIVE === 0 ? 'is-quiet' : '!text-amber-500',
            )}
          >
            {totals.counts.ACTIVE}
          </div>
        </div>
        <div className="admin-metric">
          <div className="admin-metric-label">Voided</div>
          <div
            className={cn(
              'admin-metric-value',
              totals.counts.VOIDED === 0 ? 'is-quiet' : '!text-rose-500',
            )}
          >
            {totals.counts.VOIDED}
          </div>
        </div>
        {hasTables ? (
          <div className="admin-metric">
            <div className="admin-metric-label">Transferred</div>
            <div
              className={cn(
                'admin-metric-value',
                totals.counts.TRANSFERRED === 0 && 'is-quiet',
              )}
            >
              {totals.counts.TRANSFERRED}
            </div>
          </div>
        ) : null}
        <div className="admin-metric">
          <div className="admin-metric-label">Total</div>
          <div className="admin-metric-value">{fmtInt(totals.grand)}</div>
        </div>
      </div>

      {loading ? (
        <div className="relative min-h-[40vh] overflow-hidden">
          <PageSpinner variant="overlay" message={t('common.loading')} />
        </div>
      ) : filteredTickets.length === 0 ? (
        <EmptyState
          icon={<IconTicket />}
          title={
            hasTables
              ? 'No tickets match this filter.'
              : 'No sales match this filter.'
          }
          description="Try a different status or another day."
        />
      ) : view === 'grid4' ? (
        <div className="admin-list grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3">
          {filteredTickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              prefs={prefs}
              computeServiceCharge={computeServiceCharge}
              mode="grid"
              onSaleCorrected={() => void refreshTickets({ silent: true })}
              autoOpen={
                shouldOpen &&
                (openTicketId
                  ? t.id === openTicketId
                  : filteredTickets.length === 1)
              }
            />
          ))}
        </div>
      ) : (
        <div className="admin-list">
          {filteredTickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              prefs={prefs}
              computeServiceCharge={computeServiceCharge}
              mode="list"
              onSaleCorrected={() => void refreshTickets({ silent: true })}
              autoOpen={
                shouldOpen &&
                (openTicketId
                  ? t.id === openTicketId
                  : filteredTickets.length === 1)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
