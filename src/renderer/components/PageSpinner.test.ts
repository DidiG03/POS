import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('PageSpinner', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/PageSpinner.tsx'),
    'utf8',
  );
  const css = readFileSync(
    resolve(process.cwd(), 'src/renderer/styles/index.css'),
    'utf8',
  );

  it('uses the branded boot stack for every variant', () => {
    expect(src).toContain('<BrandMark size="lg" />');
    expect(src).toContain('SpinnerGlyph');
    const brand = src.indexOf('<BrandMark');
    expect(brand).toBeGreaterThan(-1);
    expect(brand).toBeLessThan(src.indexOf("variant === 'lock'"));
    expect(src).not.toMatch(/bg-gray-900|text-gray-200/);
  });

  it('sits in the content well so header and tabs stay visible', () => {
    expect(src).toContain('pos-loader');
    expect(src).toContain('pos-loader--lock');
    expect(src).not.toContain('min-h-screen');
    expect(src).not.toContain('fixed inset-0');
    expect(css).toContain('--pos-loader-top');
    expect(css).toContain('--pos-loader-bottom');
    expect(css).toContain('.pos-loader {');
  });
});
