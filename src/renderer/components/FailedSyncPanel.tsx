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
        <div className="pos-overlay" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            className="pos-dialog relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden sm:rounded-[0.85rem]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--pos-border)] px-4 py-3">
              <div className="pos-dialog-title">{t('failedSync.title')}</div>
              <button
                type="button"
                className="pos-ticket-iconbtn"
                onClick={() => setOpen(false)}
                aria-label={t('common.close')}
              >
                <IconClose />
              </button>
            </div>

            <ul className="flex-1 space-y-2 overflow-auto p-3">
              {items.map((it) => (
                <li key={it.id} className="pos-order-card !p-3">
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
                        <span className="ml-2 font-normal text-[color:var(--pos-fg-muted)]">
                          {describeTarget(it, hasTables)}
                        </span>
                      )}
                    </div>
                    <span className="whitespace-nowrap text-[11px] text-[color:var(--pos-fg-muted)]">
                      {t('failedSync.failedAt', {
                        time: new Date(it.failedAt).toLocaleTimeString(),
                      })}
                    </span>
                  </div>
                  <div className="pos-alert mt-2">
                    {it.reason === 'rejected'
                      ? t('failedSync.reasonRejected')
                      : t('failedSync.reasonExhausted')}
                    {it.lastError ? ` — ${it.lastError}` : ''}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="pos-ticket-pay !w-auto flex-1 !min-h-11 !text-[13px]"
                      disabled={busyId === it.id}
                      onClick={() => void handleRetry(it.id)}
                    >
                      {t('failedSync.retry')}
                    </button>
                    <button
                      type="button"
                      className="pos-ticket-tool !flex-1"
                      disabled={busyId === it.id}
                      onClick={() => void handleDismiss(it.id)}
                    >
                      {t('failedSync.dismiss')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--pos-border)] px-3 py-3">
              <button
                type="button"
                className="pos-ticket-pay !w-auto !px-4"
                onClick={() => void handleRetryAll()}
              >
                {t('failedSync.retryAll')}
              </button>
              <button
                type="button"
                className="pos-ticket-tool !flex-none"
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
