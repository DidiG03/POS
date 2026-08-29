import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReservationDTO } from '@shared/ipc';
import { DEFAULT_RESERVATION_DURATION_MIN } from '@shared/reservationDuration';
import { ReservationDurationPicker } from './ReservationDurationPicker';

export type WalkInDialogProps = {
  open: boolean;
  onClose: () => void;
  area: string;
  actorId: number;
  // All known table labels in this area.
  tableLabels: string[];
  // Subset of tableLabels that are currently free (no live reservation).
  freeTableLabels: string[];
  /** Prefill the table dropdown when seating from a specific table sheet. */
  initialTableLabel?: string;
  onSeated: (r: ReservationDTO) => void;
};

const QUICK_PARTY: number[] = [1, 2, 3, 4, 5, 6, 8];

// Strip Electron's ipcRenderer error wrapper so the user sees the real text.
function cleanIpcMessage(e: any, fallback: string): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return fallback;
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || fallback;
}

function naturalSort(a: string, b: string): number {
  const an = Number((a.match(/\d+/) || ['0'])[0]);
  const bn = Number((b.match(/\d+/) || ['0'])[0]);
  if (an !== bn) return an - bn;
  return a.localeCompare(b);
}

export default function WalkInDialog({
  open,
  onClose,
  area,
  actorId,
  freeTableLabels,
  initialTableLabel,
  onSeated,
}: WalkInDialogProps) {
  const { t } = useTranslation();
  const walkInDefault = t('reservations.walkInDefault');
  const [name, setName] = useState(walkInDefault);
  const [phone, setPhone] = useState('');
  const [partySize, setPartySize] = useState<number>(2);
  const [durationMin, setDurationMin] = useState<number>(
    DEFAULT_RESERVATION_DURATION_MIN,
  );
  const [tableLabel, setTableLabel] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const freeSorted = useMemo(
    () => [...new Set(freeTableLabels)].sort(naturalSort),
    [freeTableLabels],
  );

  // Reset the form each time the dialog opens (not on occupancy ticks).
  useEffect(() => {
    if (!open) return;
    setName(t('reservations.walkInDefault'));
    setPhone('');
    setPartySize(2);
    setDurationMin(DEFAULT_RESERVATION_DURATION_MIN);
    setNote('');
    setError(null);
    setBusy(false);
    const preferred = String(initialTableLabel || '').trim();
    if (preferred && freeSorted.includes(preferred)) {
      setTableLabel(preferred);
      return;
    }
    setTableLabel(freeSorted[0] || '');
    // freeSorted is read on open; occupancy while open is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTableLabel, t]);

  // If a selected table becomes occupied while the dialog is open, drop it.
  useEffect(() => {
    if (!open || !tableLabel) return;
    if (!freeSorted.includes(tableLabel)) {
      setTableLabel(freeSorted[0] || '');
    }
  }, [open, tableLabel, freeSorted]);

  if (!open) return null;

  async function seat() {
    setError(null);
    const cleanName = name.trim() || t('reservations.walkInDefault');
    if (!area) {
      setError(t('reservations.pickAreaFirst'));
      return;
    }
    setBusy(true);
    try {
      const r = await window.api.reservations.create({
        area,
        tableLabel: tableLabel || null,
        customerName: cleanName,
        customerPhone: phone.trim() || null,
        partySize,
        // "Now" — the conflict guard treats this as occupying the table for
        // `durationMin` minutes from this moment.
        startsAtIso: new Date().toISOString(),
        durationMin,
        note: note.trim() || null,
        createdById: actorId,
        status: 'SEATED',
      });
      onSeated(r);
      onClose();
    } catch (e) {
      setError(cleanIpcMessage(e, t('reservations.somethingWrong')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[92dvh] sm:max-h-[90vh] bg-gray-800 border border-gray-700 sm:rounded-lg rounded-t-2xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide opacity-70 truncate">
              {area}
            </div>
            <div className="text-lg font-semibold">
              {t('reservations.seatWalkIn')}
            </div>
          </div>
          <button
            type="button"
            className="px-3 py-2 rounded hover:bg-gray-700 text-lg leading-none"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs opacity-70 mb-1">
                {t('reservations.nameOptional')}
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
                placeholder={t('reservations.walkInDefault')}
              />
            </label>
            <label className="block">
              <div className="text-xs opacity-70 mb-1">
                {t('reservations.phoneOptional')}
              </div>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
                placeholder="+355 ..."
                inputMode="tel"
              />
            </label>
          </div>

          <div>
            <div className="text-xs opacity-70 mb-1">
              {t('reservations.partySize')}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {QUICK_PARTY.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPartySize(n)}
                  className={`w-10 h-10 sm:w-9 sm:h-9 rounded text-base sm:text-sm ${
                    partySize === n
                      ? 'bg-blue-600'
                      : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                >
                  {n}
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={200}
                value={partySize}
                onChange={(e) =>
                  setPartySize(
                    Math.max(1, Math.min(200, Number(e.target.value) || 1)),
                  )
                }
                className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-2 text-base sm:text-sm text-right"
                title={t('reservations.customPartySize')}
                inputMode="numeric"
              />
            </div>
          </div>

          <div>
            <div className="text-xs opacity-70 mb-1">
              {t('reservations.duration')}
            </div>
            <ReservationDurationPicker
              value={durationMin}
              onChange={setDurationMin}
            />
          </div>

          <label className="block">
            <div className="text-xs opacity-70 mb-1">{t('common.table')}</div>
            <select
              value={tableLabel}
              onChange={(e) => setTableLabel(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
            >
              <option value="">{t('reservations.noSpecificTable')}</option>
              {freeSorted.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
            <div className="text-[11px] opacity-60 mt-1">
              {freeSorted.length === 0
                ? t('reservations.noFreeTables')
                : t('reservations.freeTablesHint')}
            </div>
          </label>

          <label className="block">
            <div className="text-xs opacity-70 mb-1">
              {t('reservations.noteOptional')}
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 min-h-[44px] text-base"
              placeholder={t('reservations.noteWalkInPlaceholder')}
            />
          </label>

          {error && <div className="text-sm text-rose-300">{error}</div>}
        </div>

        <div className="flex items-center gap-2 p-3 border-t border-gray-700">
          <button
            type="button"
            className="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
            onClick={onClose}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="ml-auto px-4 py-2.5 rounded bg-rose-700 hover:bg-rose-600 disabled:opacity-60 font-medium"
            onClick={seat}
            disabled={busy}
            title={t('reservations.seatNowTitle')}
          >
            {busy ? t('reservations.seating') : t('reservations.seatNow')}
          </button>
        </div>
      </div>
    </div>
  );
}
