export function floorTableA11yName(opts: {
  label: string;
  occupied: boolean;
  openLabel: string;
  freeLabel: string;
  detail?: string | null;
}): string {
  const label = String(opts.label || '').trim() || 'Table';
  const status = opts.occupied ? opts.openLabel : opts.freeLabel;
  const detail = String(opts.detail || '')
    .replace(/^[\s·•]+/, '')
    .trim();
  return detail ? `${label}, ${status}, ${detail}` : `${label}, ${status}`;
}
