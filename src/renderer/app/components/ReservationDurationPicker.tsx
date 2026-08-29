import { useMemo } from 'react';
import {
  RESERVATION_DURATION_PRESETS,
  formatReservationDuration,
} from '@shared/reservationDuration';

export function ReservationDurationPicker({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (mins: number) => void;
  disabled?: boolean;
}) {
  const options = useMemo(() => {
    const list = [...RESERVATION_DURATION_PRESETS];
    if (value > 0 && !list.some((p) => p.mins === value)) {
      list.push({ mins: value, label: formatReservationDuration(value) });
    }
    return list;
  }, [value]);

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {options.map((d) => (
        <button
          key={d.mins}
          type="button"
          disabled={disabled}
          onClick={() => onChange(d.mins)}
          className={`px-3 py-2 sm:py-1.5 rounded text-base sm:text-sm disabled:opacity-60 ${
            value === d.mins ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'
          }`}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}
