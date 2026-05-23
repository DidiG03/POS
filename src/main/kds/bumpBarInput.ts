import type { BrowserWindow } from 'electron';

import {
  kdsBumpBarActionFromKeyInput,
  type KdsBumpBarAction,
} from '@shared/kdsBumpBar';

function isOnKdsDisplay(win: BrowserWindow): boolean {
  try {
    const url = win.webContents.getURL();
    const hash = url.split('#')[1] || '';
    return hash === '/kds';
  } catch {
    return false;
  }
}

/** Capture bump-bar keys at the Electron window level (before page focus matters). */
export function attachKdsBumpBarInput(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!isOnKdsDisplay(win)) return;

    const action: KdsBumpBarAction | null = kdsBumpBarActionFromKeyInput({
      key: input.key,
      code: input.code,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
    });
    if (!action) return;

    event.preventDefault();
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('kds:bumpBarAction', action);
    }
  });
}
