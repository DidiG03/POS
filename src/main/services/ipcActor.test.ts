import { describe, expect, it } from 'vitest';
import { actorIdentityAllows, resolveActorUserId } from './ipcActor';
import type { IpcSession } from './ipcSession';

const session = (userId: number, role: string): IpcSession => ({
  tokenHash: 'hash',
  userId,
  role,
  displayName: 'Someone',
  issuedAt: 0,
  expiresAt: Date.now() + 60_000,
});

describe('actorIdentityAllows', () => {
  it('lets a waiter act as themselves', () => {
    expect(actorIdentityAllows({ session: session(4, 'WAITER') }, 4)).toBe(
      true,
    );
  });

  it('stops a waiter acting as a colleague', () => {
    expect(actorIdentityAllows({ session: session(4, 'WAITER') }, 9)).toBe(
      false,
    );
  });

  it('lets an admin act on another user', () => {
    expect(actorIdentityAllows({ session: session(1, 'ADMIN') }, 9)).toBe(true);
  });

  it('leaves login-less kiosk windows alone', () => {
    expect(actorIdentityAllows({ session: null }, 9)).toBe(true);
  });

  it('ignores a missing or unusable id rather than denying', () => {
    const ctx = { session: session(4, 'WAITER') };
    expect(actorIdentityAllows(ctx, undefined)).toBe(true);
    expect(actorIdentityAllows(ctx, 0)).toBe(true);
    expect(actorIdentityAllows(ctx, 'abc')).toBe(true);
  });
});

describe('resolveActorUserId', () => {
  it('pins a waiter to their own id whatever the payload says', () => {
    expect(resolveActorUserId({ session: session(4, 'WAITER') }, 9)).toBe(4);
    expect(
      resolveActorUserId({ session: session(4, 'WAITER') }, undefined),
    ).toBe(4);
  });

  it('honours an admin acting for someone else', () => {
    expect(resolveActorUserId({ session: session(1, 'ADMIN') }, 9)).toBe(9);
  });

  it('falls back to the admin themselves when no id is given', () => {
    expect(resolveActorUserId({ session: session(1, 'ADMIN') }, null)).toBe(1);
  });

  it('passes the claim through when there is no session', () => {
    expect(resolveActorUserId({ session: null }, 9)).toBe(9);
    expect(resolveActorUserId(null, undefined)).toBe(0);
  });
});
