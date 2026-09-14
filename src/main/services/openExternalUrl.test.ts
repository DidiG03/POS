import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { sanitizeExternalUrl } from './openExternalUrl';

describe('sanitizeExternalUrl', () => {
  it('keeps the CIS hash query that InvoiceCheck needs', () => {
    const url =
      'https://efiskalizimi-app.tatime.gov.al/invoice-check/#/verify?iic=A1&tin=L1&crtd=2026-09-10T19:59:05+02:00&prc=1600.00';
    expect(sanitizeExternalUrl(url)).toBe(url);
  });

  it('rejects non-web schemes', () => {
    expect(sanitizeExternalUrl('file:///tmp/x')).toBeNull();
    expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull();
  });
});
