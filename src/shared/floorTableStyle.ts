/** Default free-table fill — neutral gray (Lightspeed-style). */
export const DEFAULT_TABLE_COLOR = '#52525b';

/** Swatches offered in the admin table inspector. */
export const TABLE_COLOR_PALETTE: string[] = [
  '#52525b', // zinc — default
  '#6b7280', // gray
  '#374151', // dark gray
  '#15803d', // emerald (legacy POS green)
  '#0e7490', // teal
  '#7c3aed', // violet
  '#be123c', // rose
  '#b45309', // amber
  '#92400e', // brown
];

export function resolveTableFillColor(custom?: string): string {
  const c = String(custom ?? '').trim();
  return c || DEFAULT_TABLE_COLOR;
}
