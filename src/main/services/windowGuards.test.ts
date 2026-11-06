import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => [] as string[]);
vi.mock('./openExternalUrl', async (orig) => ({
  ...(await orig<any>()),
  openExternalUrl: async (u: string) => {
    opened.push(u);
    return true;
  },
}));
vi.mock('electron', () => ({ shell: {} }));

import { guardWebContents, isAppPageUrl } from './windowGuards';

const index = path.resolve('/opt/onetap/renderer/index.html');
const page = { rendererIndexHtml: index };
const appUrl = pathToFileURL(index).href;

describe('isAppPageUrl', () => {
  it('accepts the renderer file with any hash or query', () => {
    expect(isAppPageUrl(`${appUrl}#/kds`, page)).toBe(true);
    expect(isAppPageUrl(`${appUrl}?posHost=1#/admin`, page)).toBe(true);
  });

  it('accepts the dev server in development', () => {
    const dev = { ...page, devUrl: 'http://localhost:5173/' };
    expect(isAppPageUrl('http://localhost:5173/#/pos', dev)).toBe(true);
    expect(isAppPageUrl('http://localhost:5174/', dev)).toBe(false);
  });

  it('refuses other files and sites', () => {
    expect(isAppPageUrl(pathToFileURL('/etc/passwd').href, page)).toBe(false);
    expect(isAppPageUrl('https://example.com/', page)).toBe(false);
    expect(isAppPageUrl('javascript:alert(1)', page)).toBe(false);
    expect(isAppPageUrl('not a url', page)).toBe(false);
  });
});

describe('guardWebContents', () => {
  function fakeContents() {
    const h: any = {};
    return {
      h,
      contents: {
        setWindowOpenHandler: (fn: any) => (h.open = fn),
        on: (ev: string, fn: any) => (h[ev] = fn),
      } as any,
    };
  }

  it('never opens an app window; web links go to the browser', () => {
    const { h, contents } = fakeContents();
    guardWebContents(contents, page);
    expect(h.open({ url: 'https://tatime.gov.al/x' })).toEqual({
      action: 'deny',
    });
    expect(h.open({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(opened).toEqual(['https://tatime.gov.al/x']);
  });

  it('blocks navigation away from the app page', () => {
    const { h, contents } = fakeContents();
    guardWebContents(contents, page);
    const away = { preventDefault: vi.fn() };
    h['will-navigate'](away, 'https://evil.example/');
    expect(away.preventDefault).toHaveBeenCalled();
    const inside = { preventDefault: vi.fn() };
    h['will-navigate'](inside, `${appUrl}#/settings`);
    expect(inside.preventDefault).not.toHaveBeenCalled();
  });
});
