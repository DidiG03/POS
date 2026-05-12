import { useEffect, useMemo, useState } from 'react';
import type { ReservationDTO } from '@shared/ipc';

export type WalkInDialogProps = {
  open: boolean;
  onClose: () => void;
  area: string;
  actorId: number;
  // All known table labels in this area.
  tableLabels: string[];
  // Subset of tableLabels that are currently free (no live reservation).
  freeTableLabels: string[];
  onSeated: (r: ReservationDTO) => void;
};

const QUICK_PARTY: number[] = [1, 2, 3, 4, 5, 6, 8];
const QUICK_DURATIONS: { mins: number; label: string }[] = [
  { mins: 60, label: '1h' },
  { mins: 90, label: '1h30' },
  { mins: 120, label: '2h' },
  { mins: 180, label: '3h' },
];

// Strip Electron's ipcRenderer error wrapper so the user sees the real text.
function cleanIpcMessage(e: any): string {
  const raw = String(e?.message || e || '').trim();
  if (!raw) return 'Something went wrong.';
  const m = raw.match(
    /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s,
  );
  return (m ? m[1] : raw).trim() || 'Something went wrong.';
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
  tableLabels,
  freeTableLabels,
  onSeated,
}: WalkInDialogProps) {
  const [name, setName] = useState('Walk-in');
  const [phone, setPhone] = useState('');
  const [partySize, setPartySize] = useState<number>(2);
  const [durationMin, setDurationMin] = useState<number>(90);
  const [tableLabel, setTableLabel] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to sensible defaults each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName('Walk-in');
    setPhone('');
    setPartySize(2);
    setDurationMin(90);
    setNote('');
    setError(null);
    setBusy(false);
    // Auto-pick the first free table to remove a click in the common case.
    const firstFree = [...freeTableLabels].sort(naturalSort)[0] || '';
    setTableLabel(firstFree);
  }, [open, freeTableLabels]);

  const tableOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { label: string; free: boolean }[] = [];
    for (const l of [...freeTableLabels].sort(naturalSort)) {
      if (!seen.has(l)) {
        out.push({ label: l, free: true });
        seen.add(l);
      }
    }
    for (const l of [...tableLabels].sort(naturalSort)) {
      if (!seen.has(l)) {
        out.push({ label: l, free: false });
        seen.add(l);
      }
    }
    return out;
  }, [tableLabels, freeTableLabels]);

  if (!open) return null;

  async function seat() {
    setError(null);
    const cleanName = name.trim() || 'Walk-in';
    if (!area) {
      setError('Pick an area first.');
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
      setError(cleanIpcMessage(e));
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
            <div className="text-lg font-semibold">Seat a walk-in</div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Name (optional)</div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
                placeholder="Walk-in"
              />
            </label>
            <label className="block">
              <div className="text-xs opacity-70 mb-1">Phone (optional)</div>
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
            <div className="text-xs opacity-70 mb-1">Party size</div>
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
                title="Custom party size"
                inputMode="numeric"
              />
            </div>
          </div>

          <div>
            <div className="text-xs opacity-70 mb-1">Duration</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {QUICK_DURATIONS.map((d) => (
                <button
                  key={d.mins}
                  type="button"
                  onClick={() => setDurationMin(d.mins)}
                  className={`px-3 py-2 sm:py-1.5 rounded text-base sm:text-sm ${
                    durationMin === d.mins
                      ? 'bg-blue-600'
                      : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <div className="text-xs opacity-70 mb-1">Table</div>
            <select
              value={tableLabel}
              onChange={(e) => setTableLabel(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-base"
            >
              <option value="">No specific table</option>
              {tableOptions.map((t) => (
                <option key={t.label} value={t.label}>
                  {t.label}
                  {t.free ? ' · Free' : ' · Busy'}
                </option>
              ))}
            </select>
            <div className="text-[11px] opacity-60 mt-1">
              Free tables are listed first. Seating onto a busy table may be
              blocked by an existing reservation.
            </div>
          </label>

          <label className="block">
            <div className="text-xs opacity-70 mb-1">Note (optional)</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 min-h-[44px] text-base"
              placeholder="Allergies, special seating, ..."
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
            Cancel
          </button>
          <button
            type="button"
            className="ml-auto px-4 py-2.5 rounded bg-rose-700 hover:bg-rose-600 disabled:opacity-60 font-medium"
            onClick={seat}
            disabled={busy}
            title="Create a SEATED reservation right now"
          >
            {busy ? 'Seating…' : 'Seat now'}
          </button>
        </div>
      </div>
    </div>
  );
}
