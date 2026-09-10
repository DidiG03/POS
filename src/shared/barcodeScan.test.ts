import { describe, expect, it } from 'vitest';
import {
  createHidBarcodeBuffer,
  findItemByProductCode,
  isPlausibleScanCode,
  normalizeProductCode,
} from './barcodeScan';

describe('barcodeScan', () => {
  it('normalizes spaces and dashes', () => {
    expect(normalizeProductCode(' 590-1234 123457 ')).toBe('5901234123457');
  });

  it('rejects short or punctuated codes', () => {
    expect(isPlausibleScanCode('12')).toBe(false);
    expect(isPlausibleScanCode('cola!')).toBe(false);
    expect(isPlausibleScanCode('5901234123457')).toBe(true);
  });

  it('matches a product by sku', () => {
    const items = [
      { sku: '5901234123457', name: 'Water' },
      { sku: 'COFFEE', name: 'Coffee' },
    ];
    expect(findItemByProductCode(items, '5901234123457')?.name).toBe('Water');
    expect(findItemByProductCode(items, 'coffee')?.name).toBe('Coffee');
    expect(findItemByProductCode(items, '999')).toBeUndefined();
  });

  it('commits a fast scanner burst plus Enter', () => {
    const buf = createHidBarcodeBuffer();
    let last: { swallow: boolean; commit?: string } = { swallow: false };
    const code = '5901234123457';
    for (let i = 0; i < code.length; i++) {
      last = buf.push(code[i], i * 5);
    }
    last = buf.push('Enter', code.length * 5);
    expect(last.commit).toBe('5901234123457');
    expect(last.swallow).toBe(true);
  });

  it('does not treat slow typing as a scan', () => {
    const buf = createHidBarcodeBuffer();
    buf.push('c', 0);
    buf.push('o', 120);
    buf.push('l', 240);
    buf.push('a', 360);
    const last = buf.push('Enter', 500);
    expect(last.commit).toBeUndefined();
    expect(last.swallow).toBe(false);
  });
});
