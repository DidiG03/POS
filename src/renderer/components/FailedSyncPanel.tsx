import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSaleLocation } from '@shared/editionCapabilities';
import { useLicenseCapabilities } from '../stores/licenseCapabilities';
import { IconClose } from './icons';
import {
  type FailedSyncItem,
  type OfflineOp,
  dismissFailedSyncItem,
  getFailedSyncItems,
  retryFailedSyncItem,
} from '../utils/offlineQueue';
import { reportAppError } from '../utils/reportAppError';

const FAILED_CHANGE_EVENT = 'offline-queue:failed-changed';

const OP_LABEL_KEY: Record<OfflineOp, string> = {
  'tickets.log': 'failedSync.opTicketsLog',
  'tickets.print': 'failedSync.opTicketsPrint',
  'payments.record': 'failedSync.opPaymentRecord',
  'tickets.voidItem': 'failedSync.opTicketsVoidItem',
  'tickets.voidTicket': 'failedSync.opTicketsVoidTicket',
  'tables.setOpen': 'failedSync.opTablesSetOpen',
  'tables.transfer': 'failedSync.opTablesTransfer',
  'covers.save': 'failedSync.opCoversSave',
};

/** Best-effort "Main Hall · T4" / "Till 3" descriptor from the op args. */
function describeTarget(item: FailedSyncItem, diningFloor: boolean): string {
  const a = (item.args || {}) as Record<string, unknown>;
  const area = a.area ? String(a.area) : '';
  const label = a.tableLabel
    ? String(a.tableLabel)
    : a.label
      ? String(a.label)
      : '';
  if (!area && !label) return '';
  return formatSaleLocation({
    diningFloor,
    area,
    tableLabel: label,
  });
}

export function FailedSyncPanel() {
  const { t } = useTranslation();
  const hasTables = useLicenseCapabilities((s) => s.hasTables);
  const [items, setItems] = useState<FailedSyncItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await getFailedSyncItems().catch(() => []);
    setItems(next);
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(FAILED_CHANGE_EVENT, onChange);
    // Cheap safety net in case an event is missed (e.g. during boot).
    const id = window.setInterval(() => void refresh(), 20000);
    return () => {
      window.removeEventListener(FAILED_CHANGE_EVENT, onChange);
      window.clearInterval(id);
    };
  }, [refresh]);

  // Close the modal automatically once everything is resolved.
  useEffect(() => {
    if (open && items.length === 0) setOpen(false);
  }, [open, items.length]);

  const handleRetry = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await retryFailedSyncItem(id);
        await refresh();
      } catch (e) {
        reportAppError(e, {
          fallback: t('failedSync.retryFailed'),
          key: `failedSync.retry:${id}`,
        });
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t],
  );

  const handleDismiss = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await dismissFailedSyncItem(id);
        await refresh();
      } catch (e) {
        reportAppError(e, {
          fallback: t('failedSync.dismissFailed'),
          key: `failedSync.dismiss:${id}`,
        });
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t],
  );

  const handleRetryAll = useCallback(async () => {
    const ids = items.map((i) => i.id);
    for (const id of ids) {
      try {
        await retryFailedSyncItem(id);
      } catch (e) {
        reportAppError(e, {
          fallback: t('failedSync.retryFailed'),
          key: `failedSync.retry:${id}`,
        });
      }
    }
    await refresh();
  }, [items, refresh, t]);

  const handleDismissAll = useCallback(async () => {
    const ids = items.map((i) => i.id);
    for (const id of ids) {
      try {
        await dismissFailedSyncItem(id);
      } catch (e) {
        reportAppError(e, {
          fallback: t('failedSync.dismissFailed'),
          key: `failedSync.dismiss:${id}`,
        });
      }
    }
    await refresh();
  }, [items, refresh, t]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="fixed left-1/2 z-[9998] max-w-[92vw] -translate-x-1/2 rounded-full border border-rose-700 bg-rose-900/90 px-4 py-2 text-xs text-rose-50 shadow-lg backdrop-blur hover:bg-rose-800/90 sm:text-sm"
        style={{
          bottom: 'calc(0.75rem + var(--pos-mobile-tab-h, 0px))',
        }}
        onClick={() => setOpen(true)}
      >
        <span className="font-semibold">
          {t('failedSync.banner', { count: items.length })}
        </span>
        <span className="ml-2 underline">{t('failedSync.review')}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
            aria-label={t('common.close')}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
          >
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between gap-3">
              <div className="font-semibold">{t('failedSync.title')}</div>
              <button
                type="button"
                className="w-9 h-9 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 flex items-center justify-center"
                onClick={() => setOpen(false)}
                aria-label={t('common.close')}
              >
                <IconClose />
              </button>
            </div>

            <ul className="flex-1 overflow-auto p-3 space-y-2">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="rounded-lg border border-gray-700 bg-gray-800/60 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-sm">
                      {t(
                        !hasTables && it.op === 'tables.setOpen'
                          ? 'failedSync.opTillOpen'
                          : !hasTables && it.op === 'covers.save'
                            ? 'failedSync.opSaleOpen'
                            : OP_LABEL_KEY[it.op] || 'failedSync.opUnknown',
                      )}
                      {describeTarget(it, hasTables) && (
                        <span className="ml-2 text-gray-400 font-normal">
                          {describeTarget(it, hasTables)}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-gray-500 whitespace-nowrap">
                      {t('failedSync.failedAt', {
                        time: new Date(it.failedAt).toLocaleTimeString(),
                      })}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-rose-300">
                    {it.reason === 'rejected'
                      ? t('failedSync.reasonRejected')
                      : t('failedSync.reasonExhausted')}
                    {it.lastError ? ` — ${it.lastError}` : ''}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-xs disabled:opacity-60"
                      disabled={busyId === it.id}
                      onClick={() => void handleRetry(it.id)}
                    >
                      {t('failedSync.retry')}
                    </button>
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-xs disabled:opacity-60"
                      disabled={busyId === it.id}
                      onClick={() => void handleDismiss(it.id)}
                    >
                      {t('failedSync.dismiss')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="px-3 py-3 border-t border-gray-700 flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 text-sm"
                onClick={() => void handleRetryAll()}
              >
                {t('failedSync.retryAll')}
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                onClick={() => void handleDismissAll()}
              >
                {t('failedSync.dismissAll')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
