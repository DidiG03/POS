import { parseKdsStation, type KdsStation } from '@shared/kdsStations';

const STORAGE_KEY = 'kds_display_station';
const THEME_STORAGE_KEY = 'kds_display_theme';

export type KdsTheme = 'dark' | 'light';

export function parseKdsTheme(value: unknown): KdsTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

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

/** Load the saved color theme for this KDS screen (defaults to dark). */
export function loadKdsTheme(): KdsTheme {
  try {
    const fromConfig = parseKdsTheme((window as any).__KDS_THEME__);
    if (fromConfig) return fromConfig;
  } catch {
    // ignore
  }
  try {
    const fromStorage = parseKdsTheme(localStorage.getItem(THEME_STORAGE_KEY));
    if (fromStorage) return fromStorage;
  } catch {
    // ignore
  }
  return 'dark';
}

/** Persist the chosen theme to localStorage and the KDS config file. */
export function saveKdsTheme(theme: KdsTheme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore
  }
  const kdsApp = (window as any).kdsApp as
    | { saveDisplayTheme?: (theme: KdsTheme) => Promise<unknown> }
    | undefined;
  if (kdsApp?.saveDisplayTheme) {
    void kdsApp.saveDisplayTheme(theme).catch(() => {});
  }
}
