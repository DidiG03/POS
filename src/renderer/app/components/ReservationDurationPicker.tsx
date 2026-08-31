import { useMemo } from 'react';
import {
  RESERVATION_DURATION_PRESETS,
  formatReservationDuration,
} from '@shared/reservationDuration';
import { Segmented } from '../../components/ui';

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
    return list.map((d) => ({
      value: d.mins,
      label: d.label,
      disabled,
    }));
  }, [value, disabled]);

  return (
    <Segmented block value={value} onChange={onChange} options={options} />
  );
}
