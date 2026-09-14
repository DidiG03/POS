import { describe, expect, it } from 'vitest';
import { fiscalOriginalVerifyUrl } from '@shared/fiscalReceipt';
import { qrModulePath } from './FiscalVerifyQr';

describe('FiscalVerifyQr', () => {
  it('encodes the CIS check URL into a scannable module path', () => {
    const url = fiscalOriginalVerifyUrl({
      fiscalNslf: 'AEEED62862AD0F62B7C376FF72C97966',
      fiscalTin: 'L12345678A',
      closedAt: '2026-09-10T19:59:05+02:00',
      total: 1600,
    });
    expect(url).toContain('iic=');
    const path = qrModulePath(url!);
    expect(path.size).toBeGreaterThan(20);
    expect(path.d.length).toBeGreaterThan(100);
    expect(path.d.startsWith('M')).toBe(true);
  });
});
