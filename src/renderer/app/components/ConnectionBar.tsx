/**
 * The connection bar on phones and the web waiter (`lineSendState.ts`):
 *   - till out of reach (after missed checks in a row, `tillLooksDown`):
 *     calm amber "Offline – N orders saved on this phone, will send
 *     automatically";
 *   - back, with orders still waiting: "Sending…";
 *   - all sent: a brief green "All sent", then nothing.
 * Tapping it lists what is waiting. There is no resend button: "Try now"
 * asks the queue to send, and the queue sends each item under the key it
 * was saved with, so nothing is sent twice.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/ui/Modal';
import {
  offlineQueue,
  QUEUE_SYNCING_EVENT,
  type WaitingItem,
} from '../../utils/offlineQueue';
import { ALL_SENT_SHOW_MS, connectionBar } from '../../utils/lineSendState';

const TONE = {
  offline: 'border-amber-500/25 bg-amber-500/12 text-amber-100',
  sending: 'border-sky-500/25 bg-sky-500/12 text-sky-100',
  allSent: 'border-emerald-500/25 bg-emerald-500/15 text-emerald-100',
} as const;

export const ConnectionBar = memo(function ConnectionBar({
  tillDown,
  waiting,
}: {
  tillDown: boolean;
  waiting: number;
}) {
  const { t } = useTranslation();
  const [syncing, setSyncing] = useState(false);
  const [emptiedAt, setEmptiedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<WaitingItem[]>([]);
  const prevWaiting = useRef(waiting);

  useEffect(() => {
    const on = (e: Event) =>
      setSyncing(Boolean((e as CustomEvent).detail?.active));
    window.addEventListener(QUEUE_SYNCING_EVENT, on);
    return () => window.removeEventListener(QUEUE_SYNCING_EVENT, on);
  }, []);
  useEffect(() => {
    if (prevWaiting.current > 0 && waiting === 0 && !tillDown) {
      const at = Date.now();
      setEmptiedAt(at);
      setNow(at);
      const timer = window.setTimeout(
        () => setNow(Date.now()),
        ALL_SENT_SHOW_MS + 50,
      );
      prevWaiting.current = waiting;
      return () => window.clearTimeout(timer);
    }
    prevWaiting.current = waiting;
  }, [waiting, tillDown]);
  useEffect(() => {
    if (!open) return;
    void offlineQueue
      .listWaiting()
      .then(setItems)
      .catch(() => setItems([]));
  }, [open, waiting]);

  const bar = connectionBar({ tillDown, waiting, syncing, emptiedAt, now });
  if (bar.kind === 'hidden') return null;
  const text =
    bar.kind === 'offline'
      ? bar.waiting > 0
        ? t('connection.offlineSaved', { count: bar.waiting })
        : t('connection.offline')
      : bar.kind === 'sending'
        ? t('connection.sending', { count: bar.waiting })
        : t('connection.allSent');
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        data-testid="connection-bar"
        data-kind={bar.kind}
        className={`flex items-center justify-center gap-2 border-b px-4 py-1.5 text-[12px] font-medium ${TONE[bar.kind]}`}
      >
        <span aria-hidden>
          {bar.kind === 'offline' ? '⚠' : bar.kind === 'sending' ? '↻' : '✓'}
        </span>
        <span className="min-w-0">{text}</span>
        {bar.kind !== 'allSent' && waiting > 0 ? (
          <button
            type="button"
            className="shrink-0 rounded border border-current/40 px-2 py-0.5"
            onClick={() => setOpen(true)}
          >
            {t('connection.show')}
          </button>
        ) : null}
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('connection.waitingTitle', { count: items.length })}
      >
        <p className="mb-2 text-[13px] text-[color:var(--pos-fg-muted)]">
          {t('connection.waitingHelp')}
        </p>
        <ul
          className="max-h-[50vh] space-y-2 overflow-auto"
          data-testid="waiting-list"
        >
          {items.map((it) => (
            <li
              key={it.id}
              className="rounded-lg border border-white/10 px-3 py-2 text-[13px]"
            >
              <div className="font-semibold">
                {[it.area, it.table].filter(Boolean).join(' · ') ||
                  t('connection.noTable')}{' '}
                <span className="font-normal text-[color:var(--pos-fg-muted)]">
                  · {t(`connection.op.${it.op}`, { defaultValue: it.op })} ·{' '}
                  {new Date(it.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {it.lines.length ? <div>{it.lines.join(', ')}</div> : null}
              {it.attempts > 0 ? (
                <div className="text-[12px] text-[color:var(--pos-fg-muted)]">
                  {t('connection.attempts', { count: it.attempts })}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="pos-btn"
            disabled={syncing}
            onClick={() => {
              window.dispatchEvent(new Event('pos:reconnect'));
              void offlineQueue.sync().catch(() => undefined);
            }}
          >
            {syncing ? t('connection.sendingNow') : t('connection.tryNow')}
          </button>
        </div>
      </Modal>
    </>
  );
});
