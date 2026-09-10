import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KdsFloorOrder, KdsFloorOrderItem } from '@shared/kdsFloorOrders';
import {
  kdsTimerUrgencyCardAccent,
  kdsTimerUrgencyFromIso,
  kdsTimerUrgencyTextClass,
} from '@shared/kdsTimerUrgency';
import { EmptyState, cn } from '../../components/ui';
import { PageSpinner } from '../../components/PageSpinner';
import { pollIntervalMs } from '../../utils/netQuality';
import { IconCheck, IconFlame } from '../../components/icons';

function fmtAgo(iso: string | null, atMs: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((atMs - t) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm < 60) return `${mm}:${String(ss).padStart(2, '0')}`;
  const hh = Math.floor(mm / 60);
  return `${hh}h ${mm % 60}m`;
}

function itemIsReady(item: KdsFloorOrderItem): boolean {
  return item.cookerBumped === true || item.ready === true;
}

function CookingIcon({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="mr-1.5 inline-flex align-[-0.12em] text-amber-500"
    >
      <IconFlame className="h-[0.9em] w-[0.9em]" />
    </span>
  );
}

function ReadyIcon({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="mr-1.5 inline-flex align-[-0.15em] text-emerald-500"
    >
      <IconCheck className="h-[0.95em] w-[0.95em]" />
    </span>
  );
}

function OrderCard({
  order,
  index,
  clockMs,
}: {
  order: KdsFloorOrder;
  index: number;
  clockMs: number;
}) {
  const { t } = useTranslation();
  const table = `${order.area} ${order.tableLabel}`.trim();
  const timeLabel = fmtAgo(order.firedAt, clockMs);
  const urgency = order.firedAt
    ? kdsTimerUrgencyFromIso(order.firedAt, clockMs)
    : null;

  return (
    <div
      className={cn(
        'relative w-full min-w-0 rounded border-2 border-gray-500 bg-gray-900 p-3',
        urgency ? kdsTimerUrgencyCardAccent(urgency) : '',
      )}
    >
      <div
        className="absolute top-2 right-2 text-[10px] font-semibold opacity-40 tabular-nums"
        aria-hidden
      >
        {index + 1}
      </div>
      <div className="mb-2 flex items-baseline justify-between gap-3 pr-6">
        <div className="min-w-0 truncate text-lg font-bold leading-tight">
          {table}
        </div>
        {timeLabel ? (
          <span
            className={cn(
              'shrink-0 font-mono text-sm tabular-nums font-semibold',
              urgency ? kdsTimerUrgencyTextClass(urgency) : 'opacity-70',
            )}
          >
            {timeLabel}
          </span>
        ) : null}
      </div>
      {order.note ? (
        <div className="mb-2 rounded border border-gray-600 bg-gray-950 p-2 text-[13px]">
          {order.note}
        </div>
      ) : null}
      <div className="space-y-1">
        {order.items.map((item) => {
          const idx = Number(item._idx);
          const ready = itemIsReady(item);
          return (
            <div
              key={`${order.ticketId}:${idx}:${item.name}`}
              className={cn(
                'flex items-start justify-between gap-2 rounded border border-gray-600 px-2 py-1 text-[13px] leading-snug',
                ready &&
                  'border-emerald-500 bg-emerald-900/25 ring-1 ring-emerald-500/70',
              )}
            >
              <div
                className={cn(
                  'min-w-0 break-words font-semibold',
                  ready ? 'text-emerald-300' : 'italic text-gray-400',
                )}
              >
                <span>
                  {ready ? (
                    <ReadyIcon label={t('waiterOrders.ready')} />
                  ) : (
                    <CookingIcon label={t('waiterOrders.cooking')} />
                  )}
                  {item.name}
                </span>
                {item.note ? (
                  <div className="mt-0.5 flex items-start gap-1.5 pl-4 text-[12px] font-normal not-italic text-gray-300">
                    <span
                      className="font-bold leading-none text-amber-400"
                      aria-hidden
                    >
                      ↳
                    </span>
                    <span className="opacity-80">{item.note}</span>
                  </div>
                ) : null}
              </div>
              <div className="shrink-0 font-bold tabular-nums">
                {Number(item.qty || 1)}x
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function WaiterOrdersPage() {
  const { t } = useTranslation();
  const [orders, setOrders] = useState<KdsFloorOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [clockMs, setClockMs] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    let pollTimer: number | null = null;
    let running = false;

    const load = async () => {
      if (!alive || running) return;
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      running = true;
      try {
        const rows = await window.api.kds.listFloorOrders();
        if (!alive) return;
        setOrders(Array.isArray(rows) ? rows : []);
      } catch {
        if (alive) setOrders([]);
      } finally {
        running = false;
        if (alive) setLoading(false);
      }
    };

    const poll = () => {
      void load().finally(() => {
        if (!alive) return;
        pollTimer = window.setTimeout(poll, pollIntervalMs(4000));
      });
    };

    const onSse = () => {
      void load();
    };

    void load();
    pollTimer = window.setTimeout(poll, pollIntervalMs(4000));
    window.addEventListener('pos:ticketsChanged', onSse);
    return () => {
      alive = false;
      if (pollTimer != null) window.clearTimeout(pollTimer);
      window.removeEventListener('pos:ticketsChanged', onSse);
    };
  }, []);

  if (loading && orders.length === 0) {
    return <PageSpinner message={t('waiterOrders.loading')} />;
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          {t('waiterOrders.title')}
        </h2>
        <div className="text-xs opacity-70">{orders.length}</div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
        {orders.length === 0 ? (
          <EmptyState
            title={t('waiterOrders.empty')}
            description={t('waiterOrders.emptyHint')}
          />
        ) : (
          <div className="grid w-full grid-cols-1 gap-3 min-[520px]:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {orders.map((order, index) => (
              <OrderCard
                key={order.ticketId}
                order={order}
                index={index}
                clockMs={clockMs}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
