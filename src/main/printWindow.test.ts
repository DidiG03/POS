import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  created: [] as any[],
  failNextLoad: false,
  appHandlers: {} as Record<string, Function[]>,
}));

vi.mock('electron', () => {
  class FakeWindow {
    destroyed = false;
    opts: any;
    handlers: Record<string, Function[]> = {};
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      print: (_o: unknown, cb: (ok: boolean, r?: string) => void) => cb(true),
    };
    constructor(opts: any) {
      this.opts = opts;
      h.created.push(this);
    }
    loadURL() {
      if (h.failNextLoad) {
        h.failNextLoad = false;
        return Promise.reject(new Error('render crashed'));
      }
      return Promise.resolve();
    }
    on(ev: string, fn: Function) {
      (this.handlers[ev] ||= []).push(fn);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      for (const fn of this.handlers.closed || []) fn();
    }
    static getAllWindows() {
      return h.created.filter((w) => !w.destroyed);
    }
  }
  return {
    BrowserWindow: FakeWindow,
    app: {
      isPackaged: false,
      isReady: () => false,
      getPath: () => '/tmp',
      on: (ev: string, fn: Function) => (h.appHandlers[ev] ||= []).push(fn),
    },
    net: { fetch: vi.fn() },
  };
});

import { BrowserWindow } from 'electron';
import { printHtmlToSystemPrinter } from './print';

describe('system printer window', () => {
  it('closes when the till window open before the first print is closed (Bugbot PR #20)', async () => {
    const till = new (BrowserWindow as any)({});
    await printHtmlToSystemPrinter({ html: '<p>0</p>' });
    const printWin = h.created[1];
    expect(printWin.destroyed).toBe(false);
    till.destroy();
    expect(printWin.destroyed).toBe(true);
    // Fresh state for the cases below.
    h.created.length = 0;
  });

  it('reuses one locked-down window across jobs', async () => {
    const a = printHtmlToSystemPrinter({ html: '<p>1</p>' });
    const b = printHtmlToSystemPrinter({ html: '<p>2</p>' });
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(h.created).toHaveLength(1);
    expect(h.created[0].opts.webPreferences).toMatchObject({
      sandbox: true,
      javascript: false,
      nodeIntegration: false,
    });
    expect(h.created[0].webContents.setWindowOpenHandler).toHaveBeenCalled();
  });

  it('replaces the window after a failed render', async () => {
    h.failNextLoad = true;
    const r = await printHtmlToSystemPrinter({ html: '<p>x</p>' });
    expect(r.ok).toBe(false);
    expect(h.created[0].destroyed).toBe(true);
    await printHtmlToSystemPrinter({ html: '<p>y</p>' });
    expect(h.created).toHaveLength(2);
  });

  it('closes when it is the last window, so the app can quit', async () => {
    const main = new (await import('electron')).BrowserWindow({} as any) as any;
    for (const fn of h.appHandlers['browser-window-created'] || [])
      fn({}, main);
    const printWin = h.created[1];
    expect(printWin.destroyed).toBe(false);
    main.destroy();
    expect(printWin.destroyed).toBe(true);
  });
});
