import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReservationDTO } from '@shared/ipc';
import {
  RESERVATION_STAY_EXTENSION_MIN,
  formatReservationClock,
  formatReservationDuration,
} from '@shared/reservationDuration';

function cleanIpcMessage(e: any, fallback: string): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return fallback;
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || fallback;
}

export function ReservationTimeUpDialog({
  reservation,
  queueCount = 1,
  actorId,
  onResolved,
}: {
  reservation: ReservationDTO | null;
  queueCount?: number;
  actorId: number;
  onResolved: (kind: 'extended' | 'freed', row: ReservationDTO) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'extend' | 'free' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    setError(null);
    setBusy(null);
  }, [reservation?.id]);

  if (!reservation) return null;
  const label = reservation.tableLabel || '—';
  const extra = Math.max(0, queueCount - 1);
  const extendLabel = formatReservationDuration(RESERVATION_STAY_EXTENSION_MIN);

  async function extendStay() {
    if (!reservation) return;
    setBusy('extend');
    setError(null);
    try {
      const updated = await window.api.reservations.update({
        id: reservation.id,
        actorId,
        durationMin:
          Number(reservation.durationMin || 0) + RESERVATION_STAY_EXTENSION_MIN,
      });
      onResolved('extended', updated);
    } catch (e) {
      setError(cleanIpcMessage(e, t('reservations.somethingWrong')));
    } finally {
      setBusy(null);
    }
  }

  async function freeTable() {
    if (!reservation) return;
    setBusy('free');
    setError(null);
    try {
      const updated = await window.api.reservations.setStatus({
        id: reservation.id,
        actorId,
        status: 'COMPLETED',
      });
      onResolved('freed', updated);
    } catch (e) {
      setError(cleanIpcMessage(e, t('reservations.somethingWrong')));
    } finally {
      setBusy(null);
    }
  }

  if (minimized) {
    return (
      <div
        className="fixed z-[45] left-3 right-3 sm:left-4 sm:right-auto sm:w-80"
        style={{
          bottom: 'max(0.75rem, env(safe-area-inset-bottom))',
        }}
      >
        <button
          type="button"
          className="w-full flex items-center gap-3 rounded-xl bg-rose-800 hover:bg-rose-700 border border-rose-500/40 shadow-lg px-3 py-3 text-left"
          onClick={() => setMinimized(false)}
          aria-expanded={false}
          title={t('reservations.timeFinishedExpand')}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-950/50 text-sm font-semibold">
            {label}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold truncate">
              {extra > 0
                ? t('reservations.timeFinishedMinimizedMore', {
                    label,
                    count: extra,
                  })
                : t('reservations.timeFinishedMinimized', { label })}
            </span>
            <span className="block text-xs opacity-80">
              {t('reservations.timeFinishedExpand')}
            </span>
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5 shrink-0 opacity-80"
            aria-hidden
          >
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 sm:p-4"
      onClick={() => {
        if (busy == null) setMinimized(true);
      }}
    >
      <div
        className="w-full sm:max-w-md bg-gray-800 border border-gray-700 sm:rounded-lg rounded-t-2xl shadow-2xl"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-expanded
      >
        <div className="p-4 pb-3 border-b border-gray-700">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide opacity-70">
                {reservation.area}
                {queueCount > 1
                  ? ` · ${t('reservations.timeFinishedQueue', {
                      current: 1,
                      total: queueCount,
                    })}`
                  : ''}
              </div>
              <div className="text-lg font-semibold mt-0.5">
                {t('reservations.timeFinishedTitle', { label })}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 -mr-1 -mt-1 rounded-lg p-2 text-gray-300 hover:bg-gray-700 hover:text-white"
              onClick={() => setMinimized(true)}
              aria-label={t('reservations.timeFinishedMinimize')}
              title={t('reservations.timeFinishedMinimizeTitle')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
                aria-hidden
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
          <div className="text-sm opacity-80 mt-1">
            {t('reservations.timeFinishedBody', {
              name: reservation.customerName,
              party: reservation.partySize,
              time: formatReservationClock(
                reservation.seatedAt || reservation.startsAt,
              ),
            })}
          </div>
        </div>
        {error && (
          <div className="px-4 pt-3 text-sm text-rose-300">{error}</div>
        )}
        <div className="p-4 flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            disabled={busy != null}
            className="flex-1 px-3 py-3 rounded bg-blue-600 hover:bg-blue-500 text-sm font-medium disabled:opacity-60"
            onClick={() => void extendStay()}
          >
            {busy === 'extend'
              ? t('common.saving')
              : t('reservations.extendTime', { duration: extendLabel })}
          </button>
          <button
            type="button"
            disabled={busy != null}
            className="flex-1 px-3 py-3 rounded bg-zinc-600 hover:bg-zinc-500 text-sm font-medium disabled:opacity-60"
            onClick={() => void freeTable()}
          >
            {busy === 'free' ? t('common.saving') : t('reservations.freeTable')}
          </button>
        </div>
      </div>
    </div>
  );
}
