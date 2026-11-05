/**
 * Audit 2026-11, M6: every device fetched the whole settings every 8 s for
 * the KDS orders switch. It now reads once, then on change events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));

vi.mock('react', () => ({
  useState: (init: unknown) => [init, () => undefined],
  // Run effects at once, keep their cleanups.
  useEffect: (fn: () => void | (() => void)) => {
    const c = fn();
    if (typeof c === 'function') h.cleanups.push(c);
  },
}));
vi.mock('../stores/licenseCapabilities', () => ({
  useLicenseCapabilities: (sel: (s: any) => unknown) =>
    sel({ hydrated: true, hasKds: true }),
}));

import { useKdsOrdersAccess } from './useKdsOrdersAccess';

let get: ReturnType<typeof vi.fn>;
let win: EventTarget & Record<string, any>;
let doc: EventTarget & { visibilityState: string };

beforeEach(() => {
  vi.useFakeTimers();
  get = vi.fn(async () => ({ kds: { enabled: true } }));
  win = Object.assign(new EventTarget(), {
    api: { settings: { get } },
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  (globalThis as any).window = win;
  (globalThis as any).document = doc;
  h.cleanups = [];
});

afterEach(() => {
  for (const c of h.cleanups) c();
  vi.useRealTimers();
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe('useKdsOrdersAccess', () => {
  it('reads settings once, not every 8 seconds', () => {
    useKdsOrdersAccess();
    expect(get).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reads again on a settings change, a reconnect, or coming back to the foreground', () => {
    useKdsOrdersAccess();
    win.dispatchEvent(new Event('pos:settingsChanged'));
    win.dispatchEvent(new Event('pos:syncCatchup'));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('stops listening when unmounted', () => {
    useKdsOrdersAccess();
    for (const c of h.cleanups) c();
    h.cleanups = [];
    win.dispatchEvent(new Event('pos:settingsChanged'));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
