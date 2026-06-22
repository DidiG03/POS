import { describe, expect, it } from 'vitest';
import {
  buildLanHttpUrl,
  formatHostForUrl,
  pickBestLanAddress,
} from './lanHost';

describe('pickBestLanAddress', () => {
  it('prefers private IPv4 over link-local IPv6', () => {
    expect(
      pickBestLanAddress([
        'fe80::f3:be4f:2089:64ee',
        '192.168.1.50',
        '10.0.0.5',
      ]),
    ).toBe('192.168.1.50');
  });

  it('ignores fe80 when no IPv4 exists', () => {
    expect(pickBestLanAddress(['fe80::f3:be4f:2089:64ee', '::1'])).toBeNull();
  });
});

describe('formatHostForUrl', () => {
  it('brackets IPv6 literals', () => {
    expect(formatHostForUrl('fe80::1')).toBe('[fe80::1]');
    expect(formatHostForUrl('192.168.1.50')).toBe('192.168.1.50');
  });
});

describe('buildLanHttpUrl', () => {
  it('builds valid IPv6 URLs', () => {
    expect(buildLanHttpUrl('fe80::abc', 3333, '/kds/debug')).toBe(
      'http://[fe80::abc]:3333/kds/debug',
    );
  });
});
