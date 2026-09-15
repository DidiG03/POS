import { describe, expect, it } from 'vitest';
import {
  httpHostForLocalPos,
  isThisMachineAddress,
  stripIpv4MappedPrefix,
} from './localPosHost';

describe('localPosHost', () => {
  it('treats mapped IPv4 and loopback as this machine', () => {
    expect(stripIpv4MappedPrefix('::ffff:192.168.33.7')).toBe('192.168.33.7');
    expect(isThisMachineAddress('127.0.0.1', [])).toBe(true);
    expect(isThisMachineAddress('::ffff:127.0.0.1', [])).toBe(true);
    expect(isThisMachineAddress('localhost', [])).toBe(true);
  });

  it('treats the till LAN address as this machine', () => {
    expect(
      isThisMachineAddress('192.168.33.7', ['192.168.33.7', '10.0.0.2']),
    ).toBe(true);
    expect(isThisMachineAddress('::ffff:192.168.33.7', ['192.168.33.7'])).toBe(
      true,
    );
    expect(isThisMachineAddress('192.168.33.20', ['192.168.33.7'])).toBe(false);
  });

  it('routes same-machine companions through loopback', () => {
    expect(httpHostForLocalPos('192.168.33.7', ['192.168.33.7'])).toBe(
      '127.0.0.1',
    );
    expect(httpHostForLocalPos('192.168.33.20', ['192.168.33.7'])).toBe(
      '192.168.33.20',
    );
  });
});
