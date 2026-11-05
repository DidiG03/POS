/**
 * Audit 2026-11, C1: a manager-approval token worked as the approving
 * admin's session on every admin route for 5 minutes.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeLanSessionToken,
  issueLanSessionToken,
  issueManagerApprovalToken,
} from './lanSessionToken';
import { issueDeviceToken } from './lanPreAuth';

const SECRET = 'a-test-secret-of-sufficient-length-123';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

describe('LAN session tokens', () => {
  it('accepts a session token the till issued', () => {
    const token = issueLanSessionToken(
      SECRET,
      { userId: 7, role: 'WAITER' },
      3600,
      NOW,
    );
    expect(decodeLanSessionToken(SECRET, token, NOW + 1000)).toEqual({
      userId: 7,
      issuedAtMs: NOW,
    });
  });

  it('refuses a manager-approval token as a session', () => {
    const approval = issueManagerApprovalToken(
      SECRET,
      { userId: 1, role: 'ADMIN' },
      300,
      NOW,
    );
    expect(decodeLanSessionToken(SECRET, approval, NOW + 1000)).toBeNull();
  });

  it('refuses device tokens (paired phone, kitchen display)', () => {
    for (const purpose of ['lan_device', 'kds_device'] as const) {
      const t = issueDeviceToken(SECRET, '123456', purpose, NOW);
      expect(decodeLanSessionToken(SECRET, t, NOW + 1000)).toBeNull();
    }
  });

  it('refuses an expired token, one with no expiry, and a bad signature', () => {
    const t = issueLanSessionToken(SECRET, { userId: 7 }, 60, NOW);
    expect(decodeLanSessionToken(SECRET, t, NOW + 61_000)).toBeNull();
    expect(
      decodeLanSessionToken('another-secret-entirely-456789', t, NOW),
    ).toBeNull();
    // Same signature scheme, no `exp`: never valid.
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const b64 = (x: string) => Buffer.from(x).toString('base64url');
    const body = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64(JSON.stringify({ sub: 7, iat: 1 }))}`;
    const sig = crypto
      .createHmac('sha256', SECRET)
      .update(body)
      .digest('base64url');
    expect(decodeLanSessionToken(SECRET, `${body}.${sig}`, NOW)).toBeNull();
    expect(decodeLanSessionToken(SECRET, 'not.a.token', NOW)).toBeNull();
    expect(decodeLanSessionToken(SECRET, '', NOW)).toBeNull();
  });
});
