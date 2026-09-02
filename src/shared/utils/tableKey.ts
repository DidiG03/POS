export function tableKey(area: string, label: string) {
  return `${area}:${label}`;
}

/** Parse `area:label` on the first colon so labels may contain `:`. */
export function splitTableKey(
  k: string,
): { area: string; label: string } | null {
  const raw = String(k || '');
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const area = raw.slice(0, idx);
  const label = raw.slice(idx + 1);
  if (!area || !label) return null;
  return { area, label };
}
