import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BillEventDTO, UserDTO } from '@shared/ipc';
import { useAdminSessionStore } from '../../stores/adminSession';
import { reportAppError } from '../../utils/reportAppError';
import { formatMoneyCompact } from '../../utils/format';
import {
  Button,
  EmptyState,
  Select,
  Table,
  TableFrame,
  Td,
  Th,
} from '../../components/ui';
import { IconReceipt } from '../../components/icons';
import {
  billEventSummary,
  billEventsTotals,
  KIND_FILTERS,
  type KindFilter,
  rangeForPreset,
  type RangePreset,
} from './billEventsView';

const PAGE = 100;

export default function AdminBillEventsPage() {
  const { t } = useTranslation();
  const me = useAdminSessionStore((s) => s.user);
  const [preset, setPreset] = useState<RangePreset>('last7');
  const [kind, setKind] = useState<KindFilter>('ALL');
  const [actor, setActor] = useState<number>(0);
  const [users, setUsers] = useState<UserDTO[]>([]);
  const [rows, setRows] = useState<BillEventDTO[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currency, setCurrency] = useState('EUR');
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await window.api.settings.get();
        const cur = String((s as any)?.currency || '').trim();
        if (!cancelled && cur) setCurrency(cur);
      } catch {
        // keep the default
      }
      try {
        const list = await window.api.auth.listUsers({ includeAdmins: true });
        if (!cancelled) setUsers(Array.isArray(list) ? list : []);
      } catch {
        // the filter is then by id only
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const range = useMemo(() => rangeForPreset(preset, new Date()), [preset]);

  const load = useCallback(
    async (beforeId: number | null) => {
      if (!me || me.role !== 'ADMIN') return;
      setLoading(true);
      try {
        const page = await window.api.admin.listBillEvents({
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          kinds: KIND_FILTERS[kind],
          actorUserId: actor || null,
          limit: PAGE,
          beforeId,
        });
        const list = Array.isArray(page) ? page : [];
        setRows((prev) => (beforeId ? [...prev, ...list] : list));
        setMore(list.length === PAGE);
      } catch (e) {
        reportAppError(e, {
          fallback: t('common.actionFailed'),
          key: 'adminBillEvents.load',
        });
      } finally {
        setLoading(false);
      }
    },
    [me, range, kind, actor, t],
  );

  useEffect(() => {
    setOpen(null);
    void load(null);
  }, [load]);

  const money = useCallback(
    (n: number | null) => (n == null ? '—' : formatMoneyCompact(currency, n)),
    [currency],
  );
  const totals = useMemo(() => billEventsTotals(rows), [rows]);
  const kindLabel = (k: string) => t(`adminBillEvents.kind.${k}`, k);
  const presets: RangePreset[] = ['today', 'yesterday', 'last7', 'last30'];
  const kinds: KindFilter[] = [
    'ALL',
    'VOIDS',
    'DISCOUNT',
    'SERVICE_CHARGE_REMOVED',
    'PRICE_CORRECTED',
    'AUTO_VOID',
  ];

  return (
    <div className="admin-page">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          value={preset}
          onChange={(e) => setPreset(e.target.value as RangePreset)}
          aria-label={t('adminBillEvents.period')}
          className="w-auto"
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {t(`adminBillEvents.preset.${p}`)}
            </option>
          ))}
        </Select>
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value as KindFilter)}
          aria-label={t('adminBillEvents.type')}
          className="w-auto"
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {t(`adminBillEvents.filter.${k}`)}
            </option>
          ))}
        </Select>
        <Select
          value={String(actor)}
          onChange={(e) => setActor(Number(e.target.value) || 0)}
          aria-label={t('adminBillEvents.person')}
          className="w-auto"
        >
          <option value="0">{t('adminBillEvents.anyone')}</option>
          {users.map((u) => (
            <option key={u.id} value={String(u.id)}>
              {u.displayName}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load(null)}
          disabled={loading}
        >
          {t('common.refresh')}
        </Button>
      </div>

      <section>
        <h2 className="admin-kicker mb-3">
          {t('adminBillEvents.title')}
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-500">
            ·{' '}
            {t('adminBillEvents.summary', {
              count: rows.length,
              amount: money(totals.amount),
            })}
            {more ? ` ${t('adminBillEvents.andMore')}` : ''}
          </span>
        </h2>
        <p className="mb-3 text-[13px] text-gray-400">
          {t('adminBillEvents.help')}
        </p>
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconReceipt />}
            title={t('adminBillEvents.emptyTitle')}
            description={
              loading ? t('common.loading') : t('adminBillEvents.emptyBody')
            }
          />
        ) : (
          <TableFrame className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>{t('adminBillEvents.col.when')}</Th>
                  <Th>{t('adminBillEvents.col.what')}</Th>
                  <Th>{t('adminBillEvents.col.table')}</Th>
                  <Th>{t('adminBillEvents.col.who')}</Th>
                  <Th>{t('adminBillEvents.col.approvedBy')}</Th>
                  <Th numeric>{t('adminBillEvents.col.amount')}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const when = new Date(r.createdAt);
                  const expanded = open === r.id;
                  const approver =
                    r.approverName ||
                    (r.approvedById ? `#${r.approvedById}` : null);
                  return (
                    <tr
                      key={r.id}
                      className="cursor-pointer hover:bg-white/3"
                      onClick={() => setOpen(expanded ? null : r.id)}
                    >
                      <Td className="whitespace-nowrap tabular text-gray-400">
                        {when.toLocaleDateString()}{' '}
                        {when.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </Td>
                      <Td>
                        <div className="font-medium text-gray-100">
                          {kindLabel(r.kind)}
                        </div>
                        <div className="text-[12px] text-gray-400">
                          {billEventSummary(r, expanded)}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {r.area} {r.tableLabel}
                      </Td>
                      <Td>
                        {r.kind === 'AUTO_VOID'
                          ? t('adminBillEvents.automatic')
                          : r.actorName ||
                            (r.actorUserId ? `#${r.actorUserId}` : '—')}
                        {r.source === 'phone' ? (
                          <span className="ml-1 text-[11px] text-gray-500">
                            {t('adminBillEvents.fromPhone')}
                          </span>
                        ) : null}
                      </Td>
                      <Td
                        className={
                          approver ||
                          r.kind === 'PRICE_CORRECTED' ||
                          r.kind === 'AUTO_VOID'
                            ? ''
                            : 'text-amber-400'
                        }
                      >
                        {approver ??
                          (r.kind === 'PRICE_CORRECTED' ||
                          r.kind === 'AUTO_VOID'
                            ? '—'
                            : t('adminBillEvents.noApproval'))}
                      </Td>
                      <Td numeric className="tabular">
                        {money(r.amount)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        )}
        {more ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={() => void load(rows[rows.length - 1]?.id ?? null)}
            >
              {t('adminBillEvents.loadMore')}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
