import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MENU_TILE_BG,
  hexLuma,
  lightenMenuTile,
  menuTileFill,
  menuTileStyle,
  readableTextOnHex,
} from './menuTileColor';

describe('menuTileFill', () => {
  it('keeps the category colour in dark mode', () => {
    expect(menuTileFill('#7f1d1d', 'dark')).toBe('#7f1d1d');
    expect(menuTileFill(null, 'dark')).toBe(FALLBACK_MENU_TILE_BG);
  });

  it('lifts dark navy to a light pastel with dark type', () => {
    const fill = menuTileFill('#243044', 'light');
    expect(hexLuma(fill)).toBeGreaterThan(0.8);
    expect(readableTextOnHex(fill)).toBe('#0f172a');
  });

  it('keeps a red drinks category distinguishable after lightening', () => {
    const fill = lightenMenuTile('#7f1d1d');
    expect(hexLuma(fill)).toBeGreaterThan(0.8);
    const navy = lightenMenuTile('#243044');
    expect(fill.toLowerCase()).not.toBe(navy.toLowerCase());
  });

  it('still uses dark type on an already-bright colour', () => {
    const fill = menuTileFill('#facc15', 'light');
    expect(readableTextOnHex(fill)).toBe('#0f172a');
  });
});

describe('menuTileStyle', () => {
  it('puts the category colour on a bottom strip, not the whole tile', () => {
    const style = menuTileStyle('#2563eb', 'dark');
    expect(style.backgroundColor).not.toBe('#2563eb');
    expect(style.boxShadow).toContain('#2563eb');
    expect(style.color).toBe('#ffffff');
    expect(style.borderRadius).toBe('0.4rem');
  });

  it('keeps a light body in light mode with the vivid strip', () => {
    const style = menuTileStyle('#7f1d1d', 'light');
    expect(hexLuma(style.backgroundColor)).toBeGreaterThan(0.8);
    expect(style.boxShadow).toContain('#7f1d1d');
  });
});
