import { parseKdsStation, type KdsStation } from '@shared/kdsStations';

const STORAGE_KEY = 'kds_display_station';

/** Load the prep station this KDS screen should show (Kitchen / Bar / Meat products). */
export function loadKdsDisplayStation(): KdsStation {
  try {
    const fromConfig = parseKdsStation((window as any).__KDS_STATION__);
    if (fromConfig) return fromConfig;
  } catch {
    // ignore
  }
  try {
    const fromStorage = parseKdsStation(localStorage.getItem(STORAGE_KEY));
    if (fromStorage) return fromStorage;
  } catch {
    // ignore
  }
  return 'KITCHEN';
}

/** Remember the selected prep station for the next time KDS opens. */
export function saveKdsDisplayStation(station: KdsStation): void {
  try {
    localStorage.setItem(STORAGE_KEY, station);
  } catch {
    // ignore
  }
  const kdsApp = (window as any).kdsApp as
    | { saveDisplayStation?: (station: KdsStation) => Promise<unknown> }
    | undefined;
  if (kdsApp?.saveDisplayStation) {
    void kdsApp.saveDisplayStation(station).catch(() => {});
  }
}
