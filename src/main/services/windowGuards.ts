/**
 * Keep every app window on the app's own page.
 *
 * No window had a navigation or `window.open` handler. React escapes the UI
 * and receipts are escaped, so nothing exploits this today, but one future
 * injection could have sent a window holding the preload bridge to another
 * site, or opened a new window that inherits it. Now:
 *   - `window.open` never creates an app window; web links open in the
 *     system browser instead (the UI's links already go that way);
 *   - a window may navigate only within the app's own page (the renderer
 *     file, or the dev server in development); a web link opens outside.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, WebContents } from 'electron';
import { openExternalUrl, sanitizeExternalUrl } from './openExternalUrl';

export type AppPage = { rendererIndexHtml: string; devUrl?: string };

function devOrigin(devUrl?: string): string | null {
  if (!devUrl) return null;
  try {
    return new URL(devUrl).origin;
  } catch {
    return null;
  }
}

/** True when `target` is the app's own page (any hash or query). */
export function isAppPageUrl(target: string, page: AppPage): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  const origin = devOrigin(page.devUrl);
  if (origin && u.origin === origin) return true;
  if (u.protocol !== 'file:') return false;
  try {
    return (
      path.resolve(fileURLToPath(u)) === path.resolve(page.rendererIndexHtml)
    );
  } catch {
    return false;
  }
}

function openOutside(url: string): void {
  if (!sanitizeExternalUrl(url)) return;
  void openExternalUrl(url).catch(() => undefined);
}

export function guardWebContents(contents: WebContents, page: AppPage): void {
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppPageUrl(url, page)) return;
    event.preventDefault();
    openOutside(url);
  });
}

/** Guard every window this app creates, now and later. */
export function installWindowGuards(app: App, page: AppPage): void {
  app.on('web-contents-created', (_e, contents) => {
    try {
      guardWebContents(contents, page);
    } catch (e) {
      console.warn('[security] window guard failed:', e);
    }
  });
}
