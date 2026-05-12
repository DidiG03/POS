import { useEffect, useMemo, useState } from 'react';
import type { ReservationDTO, ReservationStatus } from '@shared/ipc';
import {
  isReservationQuickStatusTooEarly,
  reservationQuickStatusUnlockHint,
} from '../../utils/reservationStatusWindow';

export type ReservationEditorProps = {
  open: boolean;
  onClose: () => void;
  // Either an existing reservation (edit mode) or initial seed values for create mode.
  initial?: Partial<ReservationDTO> | null;
  /** Areas configured in Admin (settings.tableAreas). */
  areas: { name: string; count?: number }[];
  /**
   * Header / floor selection — default area when creating unless `initial.area`
   * is set (e.g. tap-to-edit from floor canvas).
   */
  defaultArea: string;
  /** Resolve TABLE labels from the saved layout for the picked area. */
  getTableLabelsForArea: (areaName: string) => Promise<string[]>;
  actorId: number;
  onSaved: (r: ReservationDTO) => void;
  onDeleted?: (id: number) => void;
};

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toDateInputValue(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function dateFromInputValue(v: string): Date {
  const [y, m, d] = v.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
    return startOfLocalDay(new Date());
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Local wall-clock HH:mm for `min` on `<input type="time">`. */
function localTimeHHMM(when: Date = new Date()): string {
  return (
    String(when.getHours()).padStart(2, '0') +
    ':' +
    String(when.getMinutes()).padStart(2, '0')
  );
}

function isoFromLocalDateAndTime(date: Date, time: string): string {
  // time is "HH:mm"
  const [hh, mm] = time.split(':').map((s) => Number(s));
  const d = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Number.isFinite(hh) ? hh : 19,
    Number.isFinite(mm) ? mm : 0,
    0,
    0,
  );
  return d.toISOString();
}

function timeFromIso(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
}

const STATUSES: ReservationStatus[] = [
  'BOOKED',
  'SEATED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
];

// Electron's ipcRenderer wraps thrown main-process errors with a verbose
// prefix like `Error invoking remote method 'reservations:create': Error: …`.
// Strip it so the user only sees our friendly message text.
function cleanErrorMessage(e: any): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return 'Something went wrong.';
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || 'Something went wrong.';
}

export default function ReservationEditor({
  open,
  onClose,
  initial,
  areas,
  defaultArea,
  getTableLabelsForArea,
  actorId,
  onSaved,
  onDeleted,
}: ReservationEditorProps) {
  const isEdit = Boolean(initial?.id);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [partySize, setPartySize] = useState<number>(2);
  const [reservationDay, setReservationDay] = useState<Date>(() =>
    startOfLocalDay(new Date()),
  );
  const [time, setTime] = useState<string>('19:00');
  const [durationMin, setDurationMin] = useState<number>(120);
  const [formArea, setFormArea] = useState<string>('');
  const [tableLabel, setTableLabel] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [layoutLabels, setLayoutLabels] = useState<string[]>([]);
  const [editNowMs, setEditNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!open || !isEdit) return;
    setEditNowMs(Date.now());
    const id = window.setInterval(() => setEditNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [open, isEdit]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    const nowWall = new Date();
    const today = startOfLocalDay(nowWall);

    let day: Date;
    if (initial?.id && initial?.startsAt) {
      day = startOfLocalDay(new Date(initial.startsAt));
    } else if (!initial?.id && initial?.startsAt) {
      const seed = startOfLocalDay(new Date(initial.startsAt));
      day = seed >= today ? seed : today;
    } else {
      day = today;
    }
    setReservationDay(day);

    let nextTime =
      initial?.startsAt != null && String(initial.startsAt).trim() !== ''
        ? timeFromIso(String(initial.startsAt))
        : '19:00';
    if (isSameLocalDay(day, today)) {
      const minT = localTimeHHMM(nowWall);
      if (nextTime < minT) nextTime = minT;
    }
    setTime(nextTime);

    const seedArea =
      (initial?.area && String(initial.area).trim()) ||
      (defaultArea && String(defaultArea).trim()) ||
      (areas[0]?.name ? String(areas[0].name) : '');
    setFormArea(seedArea);
    if (initial && initial.id) {
      setCustomerName(initial.customerName || '');
      setCustomerPhone(initial.customerPhone || '');
      setPartySize(Number(initial.partySize || 2));
      setDurationMin(Number(initial.durationMin || 120));
      setTableLabel(initial.tableLabel || '');
      setNote(initial.note || '');
    } else {
      setCustomerName(initial?.customerName || '');
      setCustomerPhone(initial?.customerPhone || '');
      setPartySize(Number(initial?.partySize || 2));
      setDurationMin(Number(initial?.durationMin || 120));
      setTableLabel(initial?.tableLabel || '');
      setNote(initial?.note || '');
    }
  }, [open, initial, defaultArea, areas]);

  useEffect(() => {
    if (!open || !formArea) {
      setLayoutLabels([]);
      setLabelsLoading(false);
      return;
    }
    let cancelled = false;
    setLabelsLoading(true);
    getTableLabelsForArea(formArea)
      .then((labels) => {
        if (!cancelled) setLayoutLabels(Array.isArray(labels) ? labels : []);
      })
      .catch(() => {
        if (!cancelled) setLayoutLabels([]);
      })
      .finally(() => {
        if (!cancelled) setLabelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, formArea, getTableLabelsForArea]);

  const tableOptions = useMemo(() => {
    const set = new Set<string>(layoutLabels);
    // Editing an existing row: keep the assigned table visible even if the
    // layout JSON lagged or the label was removed from the floor plan.
    if (
      initial?.tableLabel &&
      initial.area &&
      String(initial.area) === String(formArea)
    ) {
      set.add(initial.tableLabel);
    }
    return Array.from(set).sort((a, b) => {
      // Natural sort: T1, T2, T10
      const an = Number((a.match(/\d+/) || ['0'])[0]);
      const bn = Number((b.match(/\d+/) || ['0'])[0]);
      if (an !== bn) return an - bn;
      return a.localeCompare(b);
    });
  }, [layoutLabels, initial?.tableLabel, initial?.area, formArea]);

  const wallClock = new Date();
  const todayStart = startOfLocalDay(wallClock);
  /** New bookings only — editing keeps historical dates visible. */
  const minDateStrForPicker = !isEdit
    ? toDateInputValue(todayStart)
    : undefined;
  const isReservationToday = isSameLocalDay(reservationDay, todayStart);
  const minTimeToday = isReservationToday
    ? localTimeHHMM(wallClock)
    : undefined;

  if (!open) return null;

  async function save() {
    setError(null);
    const name = customerName.trim();
    if (!name) {
      setError('Customer name is required.');
      return;
    }
    if (!formArea) {
      setError('Choose an area (e.g. Main hall or Terrace).');
      return;
    }
    const startsAtIso = isoFromLocalDateAndTime(reservationDay, time);
    const proposedMs = new Date(startsAtIso).getTime();
    if (!isEdit) {
      if (startOfLocalDay(reservationDay).getTime() < todayStart.getTime()) {
        setError('Cannot book on a past date.');
        return;
      }
      const slackMs = 45_000;
      if (proposedMs < Date.now() - slackMs) {
        setError(
          'Choose a time in the future. For today, the booking cannot start before the current time.',
        );
        return;
      }
    }
    setBusy(true);
    try {
      let r: ReservationDTO;
      if (isEdit && initial?.id) {
        r = await window.api.reservations.update({
          id: initial.id,
          actorId,
          area: formArea,
          tableLabel: tableLabel || null,
          customerName: name,
          customerPhone: customerPhone.trim() || null,
          partySize,
          startsAtIso,
          durationMin,
          note: note.trim() || null,
        });
      } else {
        r = await window.api.reservations.create({
          area: formArea,
          tableLabel: tableLabel || null,
          customerName: name,
          customerPhone: customerPhone.trim() || null,
          partySize,
          startsAtIso,
          durationMin,
          note: note.trim() || null,
          createdById: actorId,
        });
      }
      onSaved(r);
      onClose();
    } catch (e: any) {
      setError(cleanErrorMessage(e) || 'Failed to save reservation.');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: ReservationStatus) {
    if (!initial?.id) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.reservations.setStatus({
        id: initial.id,
        actorId,
        status,
      });
      onSaved(r);
      onClose();
    } catch (e: any) {
      setError(cleanErrorMessage(e) || 'Failed to update status.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial?.id) return;
    if (!window.confirm('Delete this reservation?')) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.reservations.delete({ id: initial.id, actorId });
      onDeleted?.(initial.id);
      onClose();
    } catch (e: any) {
      setError(cleanErrorMessage(e) || 'Failed to delete reservation.');
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
        // Bottom-sheet on phones (full width, top-rounded), centered card on
        // tablet/desktop. Use `dvh` so iOS Safari's collapsing toolbar doesn't
        // hide form fields underneath itself.
        className="w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[90vh] bg-gray-800 border border-gray-700 sm:rounded-lg rounded-t-2xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-700/60">
          <div className="text-lg font-semibold">
            {isEdit ? 'Edit reservation' : 'New reservation'}
          </div>
          <button
            type="button"
            className="px-3 py-2 rounded hover:bg-gray-700 text-lg leading-none"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {isEdit && (
            <div className="text-xs opacity-70">
              Status:{' '}
              <span className="uppercase tracking-wide">
                {String(initial?.status || 'BOOKED')}
              </span>
            </div>
          )}

          <label className="block">
            <div className="text-xs opacity-70 mb-1">Customer name</div>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              // text-base (16px) prevents iOS Safari focus auto-zoom.
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
              placeholder="e.g. Sefrid Kapllani"
              autoFocus
            />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Phone (optional)</div>
              <input
                type="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
                placeholder="+355 ..."
                inputMode="tel"
              />
            </label>
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Party size</div>
              <input
                type="number"
                min={1}
                max={200}
                value={partySize}
                onChange={(e) => setPartySize(Number(e.target.value || 0))}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
                inputMode="numeric"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Date</div>
              <input
                type="date"
                value={toDateInputValue(reservationDay)}
                min={minDateStrForPicker}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  let picked = dateFromInputValue(v);
                  const t0 = startOfLocalDay(new Date());
                  if (!isEdit && picked.getTime() < t0.getTime()) {
                    picked = t0;
                  }
                  setReservationDay(picked);
                  if (isSameLocalDay(picked, startOfLocalDay(new Date()))) {
                    const minT = localTimeHHMM(new Date());
                    setTime((cur) => (cur < minT ? minT : cur));
                  }
                }}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
              />
            </label>
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Time</div>
              <input
                type="time"
                value={time}
                min={minTimeToday}
                disabled={busy}
                onChange={(e) => {
                  let v = e.target.value;
                  if (minTimeToday && v < minTimeToday) v = minTimeToday;
                  setTime(v);
                }}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
              />
            </label>
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Duration (min)</div>
              <select
                value={durationMin}
                onChange={(e) => setDurationMin(Number(e.target.value))}
                disabled={busy}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
              >
                {[60, 90, 120, 150, 180, 240, 300, 360].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Area</div>
              <select
                value={formArea}
                onChange={(e) => {
                  setFormArea(e.target.value);
                  setTableLabel('');
                }}
                disabled={areas.length === 0 || busy}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base disabled:opacity-50"
              >
                {areas.length === 0 ? (
                  <option value="">No areas configured</option>
                ) : (
                  areas.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))
                )}
              </select>
              {labelsLoading && (
                <div className="text-[11px] opacity-60 mt-1">
                  Loading tables…
                </div>
              )}
              {!labelsLoading &&
                formArea &&
                tableOptions.length === 0 &&
                areas.length > 0 && (
                  <div className="text-[11px] text-amber-200/90 mt-1">
                    No tables on this floor plan yet — ask Admin to place tables
                    for this area, or leave Table blank.
                  </div>
                )}
            </label>
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Table</div>
              <select
                value={tableLabel}
                onChange={(e) => setTableLabel(e.target.value)}
                disabled={!formArea || busy}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base disabled:opacity-50"
              >
                <option value="">No specific table</option>
                {tableOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <div className="text-xs opacity-70 mb-1">Note</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 min-h-[60px] text-base"
              placeholder="Allergies, special occasion, special seating, ..."
            />
          </label>

          {error && <div className="text-sm text-rose-300">{error}</div>}
        </div>

        <div className="border-t border-gray-700/60 p-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="px-3 py-3 sm:py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 font-medium order-1 sm:order-none"
          >
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create reservation'}
          </button>
          {isEdit && (
            <div className="sm:ml-auto flex items-center gap-1 flex-wrap order-2 sm:order-none">
              {STATUSES.filter((s) => s !== initial?.status).map((s) => {
                const startsAtIso = isoFromLocalDateAndTime(
                  reservationDay,
                  time,
                );
                const tooEarly = isReservationQuickStatusTooEarly(
                  editNowMs,
                  startsAtIso,
                  s,
                );
                const unlockAt = reservationQuickStatusUnlockHint(startsAtIso);
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={busy || tooEarly}
                    onClick={() => setStatus(s)}
                    className="px-2 py-1.5 rounded text-xs uppercase tracking-wide bg-gray-700 hover:bg-gray-600 disabled:opacity-60"
                    title={
                      tooEarly
                        ? `Available from ${unlockAt} (15 min before reservation)`
                        : `Mark as ${s}`
                    }
                  >
                    {s.replace('_', ' ')}
                  </button>
                );
              })}
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="px-2 py-1.5 rounded text-xs bg-rose-700 hover:bg-rose-600 disabled:opacity-60"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
