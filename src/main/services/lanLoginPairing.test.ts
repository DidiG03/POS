import { describe, expect, it } from 'vitest';
import { lanLoginRequiresPairingCode } from './lanLoginPairing';

describe('lanLoginRequiresPairingCode', () => {
  it('never requires a code on the till itself', () => {
    expect(
      lanLoginRequiresPairingCode({
        requirePairing: true,
        loopback: true,
        role: 'WAITER',
      }),
    ).toBe(false);
  });

  it('skips pairing for admin PINs on the LAN', () => {
    expect(
      lanLoginRequiresPairingCode({
        requirePairing: true,
        loopback: false,
        role: 'ADMIN',
      }),
    ).toBe(false);
  });

  it('still requires pairing for staff and host devices', () => {
    expect(
      lanLoginRequiresPairingCode({
        requirePairing: true,
        loopback: false,
        role: 'WAITER',
      }),
    ).toBe(true);
    expect(
      lanLoginRequiresPairingCode({
        requirePairing: true,
        loopback: false,
        role: 'HOST',
      }),
    ).toBe(true);
  });

  it('does nothing when pairing is turned off', () => {
    expect(
      lanLoginRequiresPairingCode({
        requirePairing: false,
        loopback: false,
        role: 'WAITER',
      }),
    ).toBe(false);
  });
});
