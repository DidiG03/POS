import type { TFunction } from 'i18next';
import type { ReservationStatus } from '@shared/ipc';

export function reservationStatusLabel(
  t: TFunction,
  status: ReservationStatus,
): string {
  return t(`reservations.status.${status}`);
}
