import { describe, expect, it } from 'vitest';
import {
  classifyLanLoginError,
  humanLoginDetail,
  isLanNetworkError,
  isPairingRejectedError,
  lanLoginErrorCopyKey,
  lanLoginUserMessage,
  loginAttemptsLeft,
} from './lanLoginError';

describe('lanLoginError', () => {
  it('treats fetch failures and timeouts as a missing host, not a pairing problem', () => {
    expect(isLanNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isPairingRejectedError(new TypeError('Failed to fetch'))).toBe(
      false,
    );
    expect(classifyLanLoginError(new TypeError('Failed to fetch'))).toBe(
      'host',
    );
    const timeout = new Error('The operation was aborted.');
    timeout.name = 'AbortError';
    expect(classifyLanLoginError(timeout)).toBe('host');
    expect(
      classifyLanLoginError(
        Object.assign(new Error('Bad gateway'), { status: 502 }),
      ),
    ).toBe('host');
    expect(lanLoginErrorCopyKey('host')).toBe('login.hostUnavailable');
  });

  it('keeps real pairing rejections distinct from host-down', () => {
    const rejected = Object.assign(new Error('pairing code required'), {
      status: 403,
    });
    expect(isPairingRejectedError(rejected)).toBe(true);
    expect(classifyLanLoginError(rejected)).toBe('pairing');
    expect(classifyLanLoginError(new Error('Pairing code required'))).toBe(
      'pairing',
    );
    expect(lanLoginErrorCopyKey('pairing')).toBe('login.pairingRequired');
  });

  it('maps wrong-PIN copy and unknown failures', () => {
    expect(classifyLanLoginError(new Error('Invalid PIN'))).toBe('invalid_pin');
    expect(lanLoginErrorCopyKey('invalid_pin')).toBe('login.invalidPin');
    expect(
      classifyLanLoginError(
        Object.assign(new Error('lan disabled'), { status: 403 }),
      ),
    ).toBe('other');
    expect(lanLoginErrorCopyKey('other')).toBe('login.loginFailed');
  });

  it('puts the real login reason on the error copy', () => {
    const t = (key: string, opts?: object) => {
      const detail = (opts as { detail?: string } | undefined)?.detail;
      return detail ? `${key}:${detail}` : key;
    };
    expect(lanLoginUserMessage(new TypeError('Failed to fetch'), t)).toBe(
      'login.hostUnavailable',
    );
    expect(lanLoginUserMessage(new Error('Pairing code required'), t)).toBe(
      'login.pairingRequired',
    );
    expect(lanLoginUserMessage(new Error('Invalid PIN'), t)).toBe(
      'login.invalidPin',
    );
    expect(
      lanLoginUserMessage(
        Object.assign(new Error('lan disabled'), { status: 403 }),
        t,
      ),
    ).toBe('login.lanDisabled');
    expect(
      lanLoginUserMessage(
        Object.assign(new Error('sqlite is busy'), { status: 500 }),
        t,
      ),
    ).toBe('login.loginFailedDetail:500 sqlite is busy');
    expect(humanLoginDetail(new TypeError('Failed to fetch'))).toBe('');
  });
  it('shows a lockout message when the till throttles sign-in', () => {
    const locked = Object.assign(new Error('Too many failed login attempts'), {
      status: 429,
      code: 'LOGIN_LOCKED',
    });
    expect(classifyLanLoginError(locked)).toBe('locked');
    expect(lanLoginErrorCopyKey('locked')).toBe('login.tooManyAttempts');
  });
});

describe('wrong PIN and lockout copy (QA round 3)', () => {
  const t = (key: string, opts?: any) =>
    `${key}${opts?.count != null ? `:${opts.count}` : ''}${opts?.minutes ? `:${opts.minutes}` : ''}`;
  it('always says how many attempts are left', () => {
    const e = Object.assign(new Error('Wrong PIN'), { attemptsLeft: 8 });
    expect(lanLoginUserMessage(e, t)).toBe('login.invalidPinAttemptsLeft:8');
    const fromBody = Object.assign(new Error('Wrong PIN'), {
      status: 401,
      data: { attemptsLeft: 3 },
    });
    expect(loginAttemptsLeft(fromBody)).toBe(3);
  });
  it('says how long sign-in is locked', () => {
    const e = Object.assign(new Error('locked'), {
      status: 429,
      retryAfterMs: 4 * 60_000 + 1,
    });
    expect(lanLoginUserMessage(e, t)).toBe('login.tooManyAttemptsFor:5');
  });
});
