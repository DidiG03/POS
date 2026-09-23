import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../../stores/adminSession';
import { reportAppError } from '../../utils/reportAppError';
import {
  EmptyState,
  SearchInput,
  StatusDot,
  Table,
  TableFrame,
  Td,
  Th,
} from '../../components/ui';
import { IconChevronRight, IconTicket } from '../../components/icons';
import { useLicenseCapabilities } from '../../stores/licenseCapabilities';

type Row = {
  id: number;
  name: string;
  active: boolean;
  tickets: number;
  paid: number;
  activeTickets: number;
  voids: number;
  transferred: number;
  total: number;
};

function todayRangeIso(): { startIso: string; endIso: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function fmtMoney(n: number): string {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export default function AdminTicketsPage() {
  const { t } = useTranslation();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const me = useAdminSessionStore((s) => s.user);
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [tracing, setTracing] = useState(
    Boolean(params.get('table') || params.get('sale')),
  );
  const [traceMiss, setTraceMiss] = useState(false);
  const dayRange = useMemo(() => todayRangeIso(), []);

  async function load() {
    if (!me || me.role !== 'ADMIN') {
      setRows([]);
      return;
    }
    try {
      const data = await window.api.admin.listTicketCounts(dayRange);
      setRows(
        Array.isArray(data)
          ? data.map((r: any) => ({
              id: Number(r.id),
              name: String(r.name || ''),
              active: Boolean(r.active),
              tickets: Number(r.tickets || 0),
              paid: Number(r.paid || 0),
              activeTickets: Number(r.activeTickets || 0),
              voids: Number(r.voids || 0),
              transferred: Number(r.transferred ?? r.transfersIn ?? 0),
              total: Number(r.total ?? r.revenue ?? 0),
            }))
          : [],
      );
    } catch (e) {
      reportAppError(e, {
        fallback: t('common.actionFailed'),
        key: 'adminTickets.load',
      });
      setRows([]);
    }
  }

  useEffect(() => {
    void load();
  }, [me?.id, me?.role, dayRange.startIso, dayRange.endIso]);

  useEffect(() => {
    const table = String(params.get('table') || '').trim();
    const area = String(params.get('area') || '').trim();
    const sale = String(params.get('sale') || '').trim();
    const startIso = params.get('start') || dayRange.startIso;
    const endIso = params.get('end') || dayRange.endIso;
    const wantStatus = String(params.get('status') || '').toUpperCase();
    if (!table && !sale) {
      setTracing(false);
      setTraceMiss(false);
      return;
    }
    if (!me || me.role !== 'ADMIN') return;
    let cancelled = false;
    setTracing(true);
    setTraceMiss(false);
    (async () => {
      const counts = await window.api.admin
        .listTicketCounts({ startIso, endIso })
        .catch(() => []);
      for (const row of counts) {
        if (cancelled) return;
        if (!row.tickets) continue;
        const tickets = await window.api.admin
          .listTicketsByUser(row.id, { startIso, endIso })
          .catch(() => []);
        const ranked = tickets.filter((ticket: any) => {
          if (sale && String(ticket?.sale?.orderId || '') === sale) return true;
          if (table && String(ticket.tableLabel || '') !== table) return false;
          if (area && String(ticket.area || '') !== area) return false;
          return Boolean(table);
        });
        const hit =
          ranked.find(
            (ticket: any) =>
              wantStatus &&
              wantStatus !== 'ALL' &&
              String(ticket.status || '').toUpperCase() === wantStatus,
          ) || ranked[0];
        if (!hit) continue;
        const next = new URLSearchParams();
        next.set('start', startIso);
        next.set('end', endIso);
        next.set('name', row.name);
        if (table) next.set('table', table);
        if (area) next.set('area', area);
        if (params.get('open')) next.set('open', '1');
        if (params.get('status')) {
          next.set('status', String(params.get('status')));
        }
        next.set('ticket', String(hit.id));
        navigate(`/admin/tickets/${row.id}?${next.toString()}`, {
          replace: true,
        });
        return;
      }
      if (!cancelled) {
        setTracing(false);
        setTraceMiss(true);
      }
    })().catch((e: unknown) => {
      reportAppError(e, {
        fallback: t('common.actionFailed'),
        key: 'adminTickets.trace',
      });
      if (!cancelled) {
        setTracing(false);
        setTraceMiss(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    me?.id,
    me?.role,
    params,
    navigate,
    dayRange.startIso,
    dayRange.endIso,
    t,
  ]);

  const filtered = rows
    .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (b.tickets !== a.tickets) return b.tickets - a.tickets;
      return a.name.localeCompare(b.name);
    });

  const openStaff = (r: Row) => {
    const q = new URLSearchParams({
      name: r.name,
      start: dayRange.startIso,
      end: dayRange.endIso,
    });
    navigate(`/admin/tickets/${r.id}?${q.toString()}`);
  };

  return (
    <div className="admin-page">
      {tracing ? (
        <div className="mb-3 text-[13px] text-gray-400">
          {t('inbox.tracingTicket', {
            table: params.get('table') || params.get('sale') || '',
          })}
        </div>
      ) : traceMiss ? (
        <div className="mb-3 rounded-lg border border-white/8 bg-white/3 px-3 py-2 text-[13px] text-gray-400">
          <div className="font-medium text-gray-200">
            {t('inbox.traceMissTitle')}
          </div>
          <div className="mt-0.5">{t('inbox.traceMissBody')}</div>
        </div>
      ) : null}

      <SearchInput
        value={q}
        onValueChange={setQ}
        placeholder="Search staff"
        className="w-full sm:w-64"
      />

      <section>
        <h2 className="admin-kicker mb-3">
          {hasTables ? 'Tickets by staff' : 'Sales by staff'}
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-500">
            · Today
          </span>
        </h2>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<IconTicket />}
            title="No staff"
            description={
              q.trim()
                ? 'No staff match that search.'
                : 'No waiters configured yet.'
            }
          />
        ) : (
          <TableFrame className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>Staff</Th>
                  <Th numeric>{hasTables ? 'Tickets' : 'Sales'}</Th>
                  <Th numeric>Paid</Th>
                  <Th numeric>Active</Th>
                  <Th numeric>Voided</Th>
                  {hasTables ? <Th numeric>Transferred</Th> : null}
                  <Th numeric>Total</Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => openStaff(r)}
                    className="cursor-pointer"
                  >
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <StatusDot tone={r.active ? 'accent' : 'neutral'} />
                        <span className="truncate font-medium text-gray-100">
                          {r.name}
                        </span>
                      </div>
                    </Td>
                    <Td numeric className="tabular">
                      {r.tickets}
                    </Td>
                    <Td numeric className="tabular text-emerald-400">
                      {r.paid > 0 ? (
                        r.paid
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </Td>
                    <Td numeric className="tabular text-amber-400">
                      {r.activeTickets > 0 ? (
                        r.activeTickets
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </Td>
                    <Td numeric className="tabular">
                      {r.voids > 0 ? (
                        <span className="text-rose-300">{r.voids}</span>
                      ) : (
                        <span className="text-gray-500">—</span>
                      )}
                    </Td>
                    {hasTables ? (
                      <Td numeric className="tabular">
                        {r.transferred > 0 ? (
                          r.transferred
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </Td>
                    ) : null}
                    <Td numeric className="tabular font-medium text-gray-100">
                      {r.total > 0 ? (
                        fmtMoney(r.total)
                      ) : (
                        <span className="font-normal text-gray-500">—</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      <button
                        type="button"
                        aria-label={`Open ${r.name}`}
                        className="pos-icon-btn size-7"
                        style={{ minHeight: 0 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openStaff(r);
                        }}
                      >
                        <IconChevronRight />
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </section>
    </div>
  );
}
