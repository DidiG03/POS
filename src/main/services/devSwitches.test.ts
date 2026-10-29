import { describe, expect, it } from 'vitest';
import { effectiveVaultFlag, licenseBypassAllowed } from './devSwitches';

describe('licenseBypassAllowed', () => {
  it('lets a development build skip the licence', () => {
    expect(licenseBypassAllowed('1', false)).toBe(true);
    expect(licenseBypassAllowed('', false)).toBe(false);
  });
  it('never lets the packaged app skip it', () => {
    expect(licenseBypassAllowed('1', true)).toBe(false);
  });
});

describe('effectiveVaultFlag', () => {
  it('ignores POS_VAULT=0 in the packaged app', () => {
    expect(
      effectiveVaultFlag({
        packaged: true,
        envValue: '0',
        protectionOff: false,
      }),
    ).toBe('1');
  });
  it('turns encryption off in the packaged app only by the owner marker', () => {
    expect(
      effectiveVaultFlag({
        packaged: true,
        envValue: '1',
        protectionOff: true,
      }),
    ).toBe('0');
    expect(
      effectiveVaultFlag({
        packaged: true,
        envValue: undefined,
        protectionOff: false,
      }),
    ).toBe('1');
  });
  it('keeps the developer value in development', () => {
    expect(
      effectiveVaultFlag({
        packaged: false,
        envValue: '0',
        protectionOff: false,
      }),
    ).toBe('0');
    expect(
      effectiveVaultFlag({
        packaged: false,
        envValue: undefined,
        protectionOff: true,
      }),
    ).toBeUndefined();
  });
});
