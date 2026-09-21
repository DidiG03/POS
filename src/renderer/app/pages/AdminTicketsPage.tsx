import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../../stores/adminSession';
import { reportAppError } from '../../utils/reportAppError';
import {
  Badge,
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
  transfersIn: number;
};

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

  async function load() {
    if (!me || me.role !== 'ADMIN') {
      setRows([]);
      return;
    }
    try {
      const data = await window.api.admin.listTicketCounts();
      setRows(Array.isArray(data) ? data : []);
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
  }, [me?.id, me?.role]);

  useEffect(() => {
    const table = String(params.get('table') || '').trim();
    const area = String(params.get('area') || '').trim();
    const sale = String(params.get('sale') || '').trim();
    const startIso = params.get('start') || undefined;
    const endIso = params.get('end') || undefined;
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
        if (startIso) next.set('start', startIso);
        if (endIso) next.set('end', endIso);
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
  }, [me?.id, me?.role, params, navigate]);

  const filtered = rows
    .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (b.tickets !== a.tickets) return b.tickets - a.tickets;
      return a.name.localeCompare(b.name);
    });

  const openStaff = (r: Row) => {
    navigate(`/admin/tickets/${r.id}?name=${encodeURIComponent(r.name)}`);
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
        </h2>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<IconTicket />}
            title="No staff"
            description={
              q.trim()
                ? 'No staff match that search.'
                : 'No waiters are set up yet.'
            }
          />
        ) : (
          <TableFrame className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>Staff</Th>
                  <Th numeric>{hasTables ? 'Tickets' : 'Sales'}</Th>
                  {hasTables ? <Th numeric>Transferred in</Th> : null}
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
                        {r.active ? (
                          <Badge tone="accent">On shift</Badge>
                        ) : null}
                      </div>
                    </Td>
                    <Td numeric className="tabular">
                      {r.tickets}
                    </Td>
                    {hasTables ? (
                      <Td numeric className="tabular">
                        {r.transfersIn > 0 ? (
                          <Badge tone="info" className="tabular">
                            {r.transfersIn}
                          </Badge>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </Td>
                    ) : null}
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
