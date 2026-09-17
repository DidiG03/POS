import { describe, expect, it } from 'vitest';
import { resolveStoredLicenseRecord } from './licenseEditionPersist';

function pos1(ed: 'STORE' | 'RESTAURANT'): string {
  const body = Buffer.from(
    JSON.stringify({ v: 2, cid: 'cus_1', em: 'a@b.com', ed }),
    'utf8',
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `POS1.${body}.sig`;
}

describe('resolveStoredLicenseRecord', () => {
  it('keeps a signed store key when billing re-issues restaurant', () => {
    const store = pos1('STORE');
    const restaurant = pos1('RESTAURANT');
    const next = resolveStoredLicenseRecord({
      remoteEdition: 'RESTAURANT',
      storedEdition: 'STORE',
      incomingKey: restaurant,
      previousKey: store,
      presentedKey: store,
    });
    expect(next.key).toBe(store);
    expect(next.edition).toBe('STORE');
  });

  it('reads store from the key when license.json has no edition field', () => {
    const store = pos1('STORE');
    const next = resolveStoredLicenseRecord({
      incomingKey: store,
      previousKey: store,
    });
    expect(next.edition).toBe('STORE');
    expect(next.key).toBe(store);
  });

  it('accepts a restaurant re-issue when the presented key is restaurant', () => {
    const restaurant = pos1('RESTAURANT');
    const next = resolveStoredLicenseRecord({
      remoteEdition: 'RESTAURANT',
      incomingKey: restaurant,
      presentedKey: restaurant,
    });
    expect(next.key).toBe(restaurant);
    expect(next.edition).toBe('RESTAURANT');
  });
});
