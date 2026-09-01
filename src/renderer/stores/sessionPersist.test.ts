import { describe, expect, it, beforeEach } from 'vitest';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  mergeSessionPersist,
  shouldDeferShiftGuard,
  SHIFT_GUARD_GRACE_MS,
} from './sessionPersist';

const future = () => Date.now() + 60 * 60 * 1000;

describe('mergeSessionPersist', () => {
  it('keeps a live login that beat rehydration', () => {
    const current = {
      user: { id: 7, displayName: 'Ana' },
      expiresAtMs: future(),
      sessionToken: 'live',
      authenticatedAt: 50,
    };
    const persisted = {
      user: null,
      expiresAtMs: null,
      sessionToken: null,
    };
    expect(mergeSessionPersist(persisted, current)).toEqual(current);
  });

  it('does not restore an expired stored session over a live login', () => {
    const current = {
      user: { id: 7, displayName: 'Ana' },
      expiresAtMs: future(),
      sessionToken: 'live',
    };
    const persisted = {
      user: { id: 3, displayName: 'Stale' },
      expiresAtMs: Date.now() - 1_000,
      sessionToken: 'old',
    };
    expect(mergeSessionPersist(persisted, current)).toEqual(current);
  });

  it('restores a stored session when memory is still empty', () => {
    const current = {
      user: null,
      expiresAtMs: null,
      sessionToken: null,
      authenticatedAt: 0,
    };
    const persisted = {
      user: { id: 3, displayName: 'Luan' },
      expiresAtMs: future(),
      sessionToken: 'stored',
    };
    expect(mergeSessionPersist(persisted, current)).toEqual({
      ...current,
      ...persisted,
      authenticatedAt: 0,
    });
  });

  it('drops an expired persisted session instead of hydrating it', () => {
    const current = {
      user: null,
      expiresAtMs: null,
      sessionToken: null,
    };
    const persisted = {
      user: { id: 3, displayName: 'Luan' },
      expiresAtMs: Date.now() - 1_000,
      sessionToken: 'stored',
    };
    expect(mergeSessionPersist(persisted, current)).toEqual({
      ...current,
      user: null,
      expiresAtMs: null,
      sessionToken: null,
    });
  });
});

describe('shouldDeferShiftGuard', () => {
  it('skips the bounce until persist has hydrated', () => {
    expect(
      shouldDeferShiftGuard({
        hasHydrated: false,
        isBrowser: true,
        isKdsContext: false,
        userId: 1,
        authenticatedAt: 0,
      }),
    ).toBe(true);
  });

  it('skips the bounce for a PIN that just succeeded', () => {
    const now = 100_000;
    expect(
      shouldDeferShiftGuard({
        hasHydrated: true,
        isBrowser: true,
        isKdsContext: false,
        userId: 1,
        authenticatedAt: now - SHIFT_GUARD_GRACE_MS + 1,
        now,
      }),
    ).toBe(true);
    expect(
      shouldDeferShiftGuard({
        hasHydrated: true,
        isBrowser: true,
        isKdsContext: false,
        userId: 1,
        authenticatedAt: now - SHIFT_GUARD_GRACE_MS - 1,
        now,
      }),
    ).toBe(false);
  });
});

describe('delayed persist rehydration', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  it('does not clobber a PIN login that finished before getItem resolved', async () => {
    type S = {
      user: { id: number } | null;
      expiresAtMs: number | null;
      sessionToken: string | null;
      setUser: (u: { id: number } | null) => void;
    };
    let resolveRead: (value: string | null) => void = () => undefined;
    const pending = new Promise<string | null>((r) => {
      resolveRead = r;
    });
    const store = create<S>()(
      persist(
        (set) => ({
          user: null,
          expiresAtMs: null,
          sessionToken: null,
          setUser: (u) =>
            set(
              u
                ? { user: u, expiresAtMs: future(), sessionToken: 'live' }
                : { user: null, expiresAtMs: null, sessionToken: null },
            ),
        }),
        {
          name: 'pos-session-race',
          storage: createJSONStorage(() => ({
            getItem: () => pending,
            setItem: () => {},
            removeItem: () => {},
          })),
          merge: (persisted, current) =>
            mergeSessionPersist(persisted, current),
          partialize: (s) => ({
            user: s.user,
            expiresAtMs: s.expiresAtMs,
            sessionToken: s.sessionToken,
          }),
        },
      ),
    );

    const hydrated = new Promise<void>((resolve) => {
      store.persist.onFinishHydration(() => resolve());
    });
    store.getState().setUser({ id: 1 });
    resolveRead(
      JSON.stringify({
        state: { user: null, expiresAtMs: null, sessionToken: null },
        version: 0,
      }),
    );
    await hydrated;
    expect(store.getState().user?.id).toBe(1);
    expect(store.getState().sessionToken).toBe('live');
  });
});
