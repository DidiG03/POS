export type KdsStation = 'KITCHEN' | 'BAR' | 'DESSERT';

export const ALL_KDS_STATIONS: KdsStation[] = ['KITCHEN', 'BAR', 'DESSERT'];

export function parseKdsStation(value: unknown): KdsStation | null {
  const s = String(value ?? '')
    .trim()
    .toUpperCase();
  if ((ALL_KDS_STATIONS as string[]).includes(s)) return s as KdsStation;
  return null;
}

/** User-facing label for a prep station (DESSERT → Meat products). */
export function kdsStationLabel(station: KdsStation): string {
  switch (station) {
    case 'KITCHEN':
      return 'Kitchen';
    case 'BAR':
      return 'Bar';
    case 'DESSERT':
      return 'Meat products';
    default:
      return station;
  }
}

export function kdsCategoryLinkLabel(station?: KdsStation | null): string {
  if (!station) return 'Not on KDS';
  return kdsStationLabel(station);
}
