import { describe, expect, it } from 'vitest';
import { normalizePosUiTheme } from './uiTheme';

describe('normalizePosUiTheme', () => {
  it('defaults to dark', () => {
    expect(normalizePosUiTheme(undefined)).toBe('dark');
    expect(normalizePosUiTheme('')).toBe('dark');
    expect(normalizePosUiTheme('DARK')).toBe('dark');
  });

  it('accepts light', () => {
    expect(normalizePosUiTheme('light')).toBe('light');
    expect(normalizePosUiTheme(' Light ')).toBe('light');
  });
});
