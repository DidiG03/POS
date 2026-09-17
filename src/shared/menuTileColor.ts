import type { PosUiTheme } from './uiTheme';

/** Default till tile when a category has no colour. */
export const FALLBACK_MENU_TILE_BG = '#243044';

export function parseHexRgb(
  hex?: string | null,
): { r: number; g: number; b: number } | null {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl(
  r: number,
  g: number,
  b: number,
): {
  h: number;
  s: number;
  l: number;
} {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0)) / 6;
  else if (max === gN) h = ((bN - rN) / d + 2) / 6;
  else h = ((rN - gN) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(
  h: number,
  s: number,
  l: number,
): { r: number; g: number; b: number } {
  if (s <= 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Rec. 601 luma 0–1 — used to pick white vs near-black type. */
export function hexLuma(hex?: string | null): number {
  const rgb = parseHexRgb(hex);
  if (!rgb) return 0;
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

/**
 * White vs near-black for an arbitrary background hex so price + name
 * stay legible on a bright yellow or a dark navy.
 */
export function readableTextOnHex(hex?: string | null): string {
  return hexLuma(hex) > 0.6 ? '#0f172a' : '#ffffff';
}

/** Keep the category hue, lift it to a paper pastel for light mode. */
export function lightenMenuTile(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) return lightenMenuTile(FALLBACK_MENU_TILE_BG);
  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const nextS = s < 0.04 ? 0 : clamp(s * 0.48, 0.16, 0.4);
  return toHex(hslToRgb(h, nextS, 0.91));
}

export function menuTileFill(
  hex: string | null | undefined,
  theme: PosUiTheme,
  fallback = FALLBACK_MENU_TILE_BG,
): string {
  const raw = parseHexRgb(hex) ? String(hex) : fallback;
  const normalised = raw.startsWith('#') ? raw : `#${raw}`;
  if (theme !== 'light') return normalised;
  return lightenMenuTile(normalised);
}

export function menuTileStyle(
  hex: string | null | undefined,
  theme: PosUiTheme,
  fallback = FALLBACK_MENU_TILE_BG,
): {
  backgroundColor: string;
  color: string;
  boxShadow: string;
  border?: string;
  borderRadius: string;
} {
  const rgb = parseHexRgb(hex);
  const raw = rgb ? String(hex) : fallback;
  const strip = raw.startsWith('#') ? raw : `#${raw}`;
  const boxShadow = `inset 0 -4px 0 0 ${strip}`;
  if (theme === 'light') {
    return {
      backgroundColor: 'white',
      color: '#0f172a',
      boxShadow,
      borderRadius: '0.4rem',
    };
  }
  return {
    backgroundColor: '#1b2433',
    color: '#ffffff',
    boxShadow,
    borderRadius: '0.4rem',
  };
}
