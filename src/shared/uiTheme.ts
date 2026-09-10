export type PosUiTheme = 'light' | 'dark';

export function normalizePosUiTheme(raw: unknown): PosUiTheme {
  return String(raw || '')
    .trim()
    .toLowerCase() === 'light'
    ? 'light'
    : 'dark';
}
