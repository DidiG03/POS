import { pickConfiguredArea, type TableArea } from '@shared/tableAreas';

const STORAGE_KEY = 'pos:waiterFloorArea';

export function readLastFloorArea(): string {
  try {
    return String(sessionStorage.getItem(STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function writeLastFloorArea(area: string): void {
  try {
    const next = String(area || '').trim();
    if (next) sessionStorage.setItem(STORAGE_KEY, next);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / no sessionStorage — floor remount still falls back to
    // the last selected table from order context.
  }
}

function areaFromLocationSearch(): string {
  try {
    return (
      new URLSearchParams(window.location.search).get('area')?.trim() || ''
    );
  } catch {
    return '';
  }
}

/**
 * Which dining floor to show when Tables remounts (after Order / Reports).
 * Prefer an explicit URL, then the waiter's last chip choice, then the table
 * they were just working — never snap back to areas[0] and strand them.
 */
export function resolveInitialFloorArea(opts: {
  areas: TableArea[];
  selectedTableArea?: string | null;
  urlArea?: string | null;
  storedArea?: string | null;
}): string {
  const url = String(opts.urlArea ?? '').trim();
  const stored = String(opts.storedArea ?? '').trim();
  const selected = String(opts.selectedTableArea ?? '').trim();
  return pickConfiguredArea(url || stored || selected || '', opts.areas);
}

export function resolveBootFloorArea(
  areas: TableArea[],
  selectedTableArea?: string | null,
): string {
  return resolveInitialFloorArea({
    areas,
    urlArea: areaFromLocationSearch(),
    storedArea: readLastFloorArea(),
    selectedTableArea,
  });
}
