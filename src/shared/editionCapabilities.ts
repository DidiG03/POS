import type { LicenseEdition } from './ipc';

export function normalizeLicenseEdition(
  raw: unknown,
): LicenseEdition | undefined {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  return v === 'STORE' || v === 'RESTAURANT' ? v : undefined;
}

/** Store plan has no reservations book. Missing edition keeps restaurant behaviour. */
export function editionHasReservations(
  edition?: LicenseEdition | string | null,
): boolean {
  return normalizeLicenseEdition(edition) !== 'STORE';
}

/** Store plan has no dining-room floor. Missing edition keeps restaurant behaviour. */
export function editionHasTables(
  edition?: LicenseEdition | string | null,
): boolean {
  return normalizeLicenseEdition(edition) !== 'STORE';
}

/** Store plan has no kitchen display. Missing edition keeps restaurant behaviour. */
export function editionHasKds(
  edition?: LicenseEdition | string | null,
): boolean {
  return normalizeLicenseEdition(edition) !== 'STORE';
}

export const STORE_COUNTER_AREA = 'Store';

export function isStoreCounterArea(area?: string | null): boolean {
  return String(area || '').trim() === STORE_COUNTER_AREA;
}

/** Receipt / sale-card location. Store tills drop the synthetic "Store" area. */
export function formatSaleLocation(input: {
  diningFloor: boolean;
  area?: string | null;
  tableLabel?: string | null;
  emptyLabel?: string;
}): string {
  const label = String(input.tableLabel || '').trim();
  if (!input.diningFloor || isStoreCounterArea(input.area)) {
    return label || input.emptyLabel || 'Sale';
  }
  const area = String(input.area || '').trim();
  if (area && label) return `${area} - ${label}`;
  return area || label;
}

export function editionAllowsStaffRole(
  edition: LicenseEdition | string | null | undefined,
  role: string,
): boolean {
  const next = String(role || '')
    .trim()
    .toUpperCase();
  return staffRolesForEdition(edition).includes(next);
}

export function storeCounterTable(userId?: number | null): {
  id: number;
  area: string;
  label: string;
} {
  const id = Number(userId);
  const tillId = Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
  return {
    id: tillId,
    area: STORE_COUNTER_AREA,
    label: tillId > 0 ? `Till ${tillId}` : 'Till',
  };
}

export function ensureStoreCounterSelected(input: {
  hasTables: boolean;
  userId?: number | null;
  selectedTable?: { area: string; label: string } | null;
  setSelectedTable: (t: { id: number; area: string; label: string }) => void;
}): void {
  if (input.hasTables) return;
  const next = storeCounterTable(input.userId);
  if (
    input.selectedTable?.area === next.area &&
    input.selectedTable?.label === next.label
  ) {
    return;
  }
  input.setSelectedTable(next);
}

export function staffPosHomePath(input: {
  hasTables: boolean;
  clockOnly?: boolean;
  kds?: boolean;
}): string {
  if (input.kds && input.hasTables) return '/kds';
  if (input.clockOnly) return '/app/clock';
  return input.hasTables ? '/app/tables' : '/app/order';
}

export const STORE_STAFF_ROLES = ['CASHIER', 'ADMIN', 'CLEANER'] as const;

export const RESTAURANT_STAFF_ROLES = [
  'WAITER',
  'CASHIER',
  'ADMIN',
  'KP',
  'CHEF',
  'HEAD_CHEF',
  'FOOD_RUNNER',
  'HOST',
  'BUSSER',
  'BARTENDER',
  'BARBACK',
  'CLEANER',
] as const;

/** Store tills only need till staff. Kitchen/host/waiter roles stay restaurant. */
export function staffRolesForEdition(
  edition?: LicenseEdition | string | null,
): readonly string[] {
  return normalizeLicenseEdition(edition) === 'STORE'
    ? STORE_STAFF_ROLES
    : RESTAURANT_STAFF_ROLES;
}

/** Packaged builds ignore env overrides so only the paid plan can change the UI. */
export function resolveActiveLicenseEdition(input: {
  unpackaged: boolean;
  envEdition?: string | null;
  storedEdition?: string | null;
}): LicenseEdition | undefined {
  if (input.unpackaged) {
    const fromEnv = normalizeLicenseEdition(input.envEdition);
    if (fromEnv) return fromEnv;
  }
  return normalizeLicenseEdition(input.storedEdition);
}
