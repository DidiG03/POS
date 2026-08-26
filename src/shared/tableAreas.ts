export type TableArea = { name: string; count: number };

/**
 * Normalize Settings → Table Areas. Empty / malformed rows are dropped so
 * a leftover "Main Hall" seed cannot sit next to the restaurant's real
 * areas and steal the selected floor on boot.
 */
export function saneTableAreas(raw: unknown): TableArea[] {
  if (!Array.isArray(raw)) return [];
  const out: TableArea[] = [];
  for (const a of raw) {
    const name = String((a as any)?.name || '').trim();
    if (!name) continue;
    const n = Number((a as any)?.count);
    out.push({
      name,
      count: Number.isFinite(n) && n > 0 ? Math.floor(n) : 8,
    });
  }
  return out;
}

/** Keep the current area if it still exists; otherwise the first configured one. */
export function pickConfiguredArea(
  current: string,
  areas: TableArea[],
): string {
  if (current && areas.some((a) => a.name === current)) return current;
  return areas[0]?.name || '';
}
