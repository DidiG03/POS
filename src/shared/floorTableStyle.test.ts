import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TABLE_COLOR,
  TABLE_COLOR_PALETTE,
  resolveTableFillColor,
} from './floorTableStyle';

describe('resolveTableFillColor', () => {
  it('uses the neutral grey default when no custom color is set', () => {
    expect(resolveTableFillColor()).toBe(DEFAULT_TABLE_COLOR);
    expect(resolveTableFillColor('')).toBe(DEFAULT_TABLE_COLOR);
  });

  it('maps the legacy POS green to grey so old layouts are not green', () => {
    expect(resolveTableFillColor('#15803d')).toBe(DEFAULT_TABLE_COLOR);
    expect(resolveTableFillColor('#15803D')).toBe(DEFAULT_TABLE_COLOR);
  });

  it('keeps an explicit non-green custom color', () => {
    expect(resolveTableFillColor('#7c3aed')).toBe('#7c3aed');
  });
});

describe('TABLE_COLOR_PALETTE', () => {
  it('does not offer green as a table fill', () => {
    expect(TABLE_COLOR_PALETTE).not.toContain('#15803d');
    expect(TABLE_COLOR_PALETTE[0]).toBe(DEFAULT_TABLE_COLOR);
  });
});
