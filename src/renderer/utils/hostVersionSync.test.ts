import { describe, expect, it } from 'vitest';
import { isHostRendererHref, planHostVersionSync } from './hostVersionSync';

describe('planHostVersionSync', () => {
  it('remembers the first version without reloading', () => {
    expect(
      planHostVersionSync({
        previous: null,
        next: '0.2.27',
        servedFromHostRenderer: true,
      }),
    ).toEqual({ persist: true, invalidate: false, reload: false });
  });

  it('reloads host-served tablets when the POS version changes', () => {
    expect(
      planHostVersionSync({
        previous: '0.2.26',
        next: '0.2.27',
        servedFromHostRenderer: true,
      }),
    ).toEqual({ persist: true, invalidate: true, reload: true });
  });

  it('invalidates native app caches without a full reload', () => {
    expect(
      planHostVersionSync({
        previous: '0.2.26',
        next: '0.2.27',
        servedFromHostRenderer: false,
      }),
    ).toEqual({ persist: true, invalidate: true, reload: false });
  });
});

describe('isHostRendererHref', () => {
  it('detects the LAN /renderer/ staff URL', () => {
    expect(
      isHostRendererHref('http://192.168.1.10:3333/renderer/?backend=1#/'),
    ).toBe(true);
    expect(isHostRendererHref('http://localhost/index.html')).toBe(false);
  });
});
