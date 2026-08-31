import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAdminSessionStore } from '../../stores/adminSession';
import { computeDateRange, type DateRangePreset } from '@shared/dateRange';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  SearchInput,
  Select,
  StatusDot,
  Table,
  TableFrame,
  Td,
  Th,
} from '../../components/ui';
import { IconChevronRight, IconTicket } from '../../components/icons';

type Row = {
  id: number;
  name: string;
  active: boolean;
  tickets: number;
  transfersIn: number;
};

export default function AdminTicketsPage() {
  const { t } = useTranslation();
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
    const { startIso, endIso } = computeDateRange(
      range,
      customStart,
      customEnd,
    );
    const data = await window.api.admin.listTicketCounts({ startIso, endIso });
    setRows(data);
  }

  useEffect(() => {
    void load();
  }, [me?.id, me?.role, range, customStart, customEnd]);

  const filtered = rows
    .filter((r) => r.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.tickets - a.tickets);

  const openStaff = (r: Row) => {
    const { startIso, endIso } = computeDateRange(
      range,
      customStart,
      customEnd,
    );
    navigate(
      `/admin/tickets/${r.id}?start=${encodeURIComponent(startIso || '')}&end=${encodeURIComponent(endIso || '')}&name=${encodeURIComponent(r.name)}`,
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 sm:space-y-5">
      <PageHeader title={t('adminLayout.tickets')} />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <SearchInput
            value={q}
            onValueChange={setQ}
            placeholder="Search staff"
            className="w-full sm:w-64"
          />
          <Select
            value={range}
            onChange={(e) => setRange(e.target.value as any)}
            className="w-full sm:w-40"
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last7">Last 7 days</option>
            <option value="last30">Last 30 days</option>
            <option value="custom">Custom</option>
          </Select>
          {range === 'custom' && (
            <>
              <Input
                type="date"
                className="w-full sm:w-40"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <Input
                type="date"
                className="w-full sm:w-40"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
              <Button onClick={load}>Apply</Button>
            </>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader title="Tickets by staff" />
        {filtered.length === 0 ? (
          <EmptyState
            icon={<IconTicket />}
            title="No staff activity"
            description="No tickets were opened by staff in the selected period."
          />
        ) : (
          <TableFrame className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>Staff</Th>
                  <Th numeric>Tickets</Th>
                  <Th numeric>Transferred in</Th>
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
                    <Td numeric className="tabular">
                      {r.transfersIn > 0 ? (
                        <span
                          title={`${r.transfersIn} ticket${r.transfersIn === 1 ? '' : 's'} received via table transfer in this period`}
                        >
                          <Badge tone="info" className="tabular">
                            {r.transfersIn}
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-gray-500">—</span>
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
      </Card>
    </div>
  );
}
