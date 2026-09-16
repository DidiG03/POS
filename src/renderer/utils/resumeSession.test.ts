import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSIST_HYDRATION_WAIT_MS,
  persistHasHydrated,
  resetResumeBindStateForTests,
  resumeMainProcessSession,
  waitForPersistHydration,
  type SessionStore,
} from './resumeSession';

function store(partial: Partial<SessionStore> = {}): SessionStore {
  return {
    getState: () => ({
      user: null,
      sessionToken: null,
      setUser: () => undefined,
      hasHydrated: false,
    }),
    ...partial,
  };
}

describe('waitForPersistHydration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not stall boot for seconds on a missed hydrate callback', () => {
    expect(PERSIST_HYDRATION_WAIT_MS).toBeLessThanOrEqual(500);
  });

  it('resolves immediately when zustand persist already hydrated', async () => {
    await expect(
      waitForPersistHydration(
        store({
          persist: {
            hasHydrated: () => true,
            onFinishHydration: () => () => undefined,
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('resolves immediately when the store flag is already set', async () => {
    await expect(
      waitForPersistHydration(
        store({
          getState: () => ({
            user: null,
            sessionToken: null,
            setUser: () => undefined,
            hasHydrated: true,
          }),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('does not wait when persist is missing', async () => {
    await expect(waitForPersistHydration(store())).resolves.toBeUndefined();
  });

  it('catches hydration that finishes between the check and the subscribe', async () => {
    let hydrated = false;
    const listeners: Array<() => void> = [];
    const s = store({
      persist: {
        hasHydrated: () => hydrated,
        onFinishHydration: (fn) => {
          listeners.push(fn);
          hydrated = true;
          return () => undefined;
        },
      },
    });
    expect(persistHasHydrated(s)).toBe(false);
    await expect(waitForPersistHydration(s)).resolves.toBeUndefined();
    expect(listeners).toHaveLength(1);
  });

  it('gives up quickly if onFinishHydration never fires', async () => {
    vi.useFakeTimers();
    const pending = waitForPersistHydration(
      store({
        persist: {
          hasHydrated: () => false,
          onFinishHydration: () => () => undefined,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(PERSIST_HYDRATION_WAIT_MS);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('resumeMainProcessSession', () => {
  afterEach(() => {
    resetResumeBindStateForTests();
    vi.unstubAllGlobals();
  });

  function sessionStore(token = 'tok-1'): SessionStore {
    return store({
      getState: () => ({
        user: { id: 1, role: 'WAITER' },
        sessionToken: token,
        setUser: () => undefined,
        hasHydrated: true,
      }),
    });
  }

  it('coalesces concurrent resumes onto one IPC call', async () => {
    let resolveResume: (value: unknown) => void = () => undefined;
    const resumeSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );
    vi.stubGlobal('window', {
      api: { auth: { resumeSession } },
    });
    const s = sessionStore();
    const a = resumeMainProcessSession(s);
    const b = resumeMainProcessSession(s);
    await Promise.resolve();
    expect(resumeSession).toHaveBeenCalledTimes(1);
    resolveResume({ userId: 1 });
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
  });

  it('does not re-hit IPC after a successful bind of the same token', async () => {
    const resumeSession = vi.fn(async () => ({ userId: 1 }));
    vi.stubGlobal('window', {
      api: { auth: { resumeSession } },
    });
    const s = sessionStore();
    await expect(resumeMainProcessSession(s)).resolves.toBe(true);
    await expect(resumeMainProcessSession(s)).resolves.toBe(true);
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when resume is rate-limited and a local session exists', async () => {
    const err = Object.assign(new Error('rate_limited'), {
      code: 'rate_limited',
    });
    const resumeSession = vi.fn(async () => {
      throw err;
    });
    vi.stubGlobal('window', {
      api: { auth: { resumeSession } },
    });
    const s = sessionStore();
    await expect(resumeMainProcessSession(s)).resolves.toBe(true);
    await expect(resumeMainProcessSession(s)).resolves.toBe(true);
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });
});
