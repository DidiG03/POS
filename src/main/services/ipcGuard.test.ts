/**
 * Access decisions for guarded IPC channels.
 */

import { describe, expect, it } from 'vitest';
import { decideAccess } from './ipcGuard';
import type { IpcCallContext } from './ipcGuard';
import type { IpcSession } from './ipcSession';

function session(role: string): IpcSession {
  return {
    tokenHash: 'hash',
    userId: 7,
    role,
    displayName: 'Test',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function ctx(overrides: Partial<IpcCallContext> = {}): IpcCallContext {
  return {
    session: null,
    senderId: 1,
    windowKind: 'pos',
    ...overrides,
  };
}

describe('decideAccess', () => {
  it('lets anyone reach a public channel', () => {
    expect(decideAccess({ allow: 'public' }, ctx()).ok).toBe(true);
  });

  it('rejects an unauthenticated caller on a session channel', () => {
    const verdict = decideAccess({ allow: 'session' }, ctx());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('unauthenticated');
  });

  it('accepts any role on a session channel', () => {
    for (const role of ['WAITER', 'CLEANER', 'ADMIN']) {
      const verdict = decideAccess(
        { allow: 'session' },
        ctx({ session: session(role) }),
      );
      expect(verdict.ok, role).toBe(true);
    }
  });

  it('accepts a listed role', () => {
    const verdict = decideAccess(
      { allow: ['ADMIN'] },
      ctx({ session: session('ADMIN') }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('rejects a role that is not listed', () => {
    const verdict = decideAccess(
      { allow: ['ADMIN'] },
      ctx({ session: session('WAITER') }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('forbidden');
  });

  it('distinguishes "nobody is logged in" from "wrong role" internally', () => {
    const anonymous = decideAccess({ allow: ['ADMIN'] }, ctx());
    const wrongRole = decideAccess(
      { allow: ['ADMIN'] },
      ctx({ session: session('WAITER') }),
    );
    expect(anonymous.ok).toBe(false);
    expect(wrongRole.ok).toBe(false);
    if (!anonymous.ok && !wrongRole.ok) {
      expect(anonymous.error.code).toBe('unauthenticated');
      expect(wrongRole.error.code).toBe('forbidden');
      // ...but both look identical to the renderer, so probing a channel
      // cannot tell an attacker which half of the check failed.
      expect(anonymous.error.message).toBe(wrongRole.error.message);
    }
  });

  it('grants a listed window even with no session', () => {
    const verdict = decideAccess(
      { allow: ['CHEF'], windows: ['kds'] },
      ctx({ windowKind: 'kds' }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('does not grant an unlisted window', () => {
    const verdict = decideAccess(
      { allow: ['CHEF'], windows: ['kds'] },
      ctx({ windowKind: 'pos' }),
    );
    expect(verdict.ok).toBe(false);
  });

  it('treats an unknown window as ungranted', () => {
    // Anything we did not explicitly register — a devtools extension host, a
    // webview we did not create — lands here and must get nothing.
    const verdict = decideAccess(
      { allow: ['CHEF'], windows: ['kds'] },
      ctx({ windowKind: 'unknown' }),
    );
    expect(verdict.ok).toBe(false);
  });

  it('compares roles case-sensitively against the normalised session role', () => {
    // Sessions upper-case the role on creation, so a lower-case role in the
    // policy table would silently never match. This asserts the direction.
    const verdict = decideAccess(
      { allow: ['admin'] },
      ctx({ session: session('ADMIN') }),
    );
    expect(verdict.ok).toBe(false);
  });
});
