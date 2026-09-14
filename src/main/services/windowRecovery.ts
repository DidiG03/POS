/**
 * Bring POS windows back after OS sleep, GPU death, or a crashed renderer.
 *
 * A laptop that slept overnight can come back with a navy `backgroundColor`
 * and no React tree. Vite HMR does this in `npm run dev`; Chromium GPU /
 * renderer process crashes do it in the packaged till. Hash + persisted
 * session/ticket stores survive `webContents.reload()`.
 *
 * Do not reload on `did-fail-load`: Chromium emits that during a normal
 * Cmd+R, and a delayed retry then kills the good page and leaves the
 * window blank.
 */

import {
  app,
  powerMonitor,
  type BrowserWindow,
  type WebContents,
} from 'electron';
import {
  shouldReloadAfterRenderGone,
  shouldReloadAfterWakePing,
  shouldRetryFailedLoad,
} from '@shared/wakeRecovery';
import { withTimeout } from './withTimeout';

const recoveringIds = new Set<number>();
const tracked = new Set<BrowserWindow>();
let powerHooked = false;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

const WAKE_PING_JS = `(() => {
  try {
    window.dispatchEvent(new Event('pos:os-resume'));
    if (document.readyState !== 'complete') return -1;
    var root = document.getElementById('root');
    return root ? root.childElementCount : 0;
  } catch (e) {
    return 0;
  }
})()`;

function windowWebContents(win: BrowserWindow) {
  if (win.isDestroyed()) return null;
  try {
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  } catch {
    return null;
  }
}

function isLoading(wc: WebContents): boolean {
  try {
    return typeof wc.isLoading === 'function' && wc.isLoading();
  } catch {
    return false;
  }
}

export function reloadWindowContents(win: BrowserWindow): boolean {
  const wc = windowWebContents(win);
  if (!wc) return false;
  if (isLoading(wc)) return false;
  const id = wc.id;
  if (recoveringIds.has(id)) return false;
  recoveringIds.add(id);
  setTimeout(() => recoveringIds.delete(id), 5000);
  try {
    if (typeof wc.isCrashed === 'function' && wc.isCrashed()) {
      wc.reloadIgnoringCache();
    } else {
      wc.reload();
    }
    return true;
  } catch {
    try {
      wc.reloadIgnoringCache();
      return true;
    } catch {
      recoveringIds.delete(id);
      return false;
    }
  }
}

async function recoverWindow(win: BrowserWindow, probeUi: boolean) {
  const wc = windowWebContents(win);
  if (!wc) return;
  if (isLoading(wc)) return;
  try {
    wc.invalidate();
  } catch {
    // ignore
  }
  const crashed = typeof wc.isCrashed === 'function' && wc.isCrashed();
  if (!probeUi && !crashed) return;
  let childCount: number | null = null;
  let pingFailed = false;
  if (probeUi && !crashed) {
    try {
      const raw = await withTimeout(
        wc.executeJavaScript(WAKE_PING_JS),
        2500,
        'wake-ping',
      );
      childCount = Number(raw);
      if (!Number.isFinite(childCount)) {
        childCount = 0;
        pingFailed = true;
      }
    } catch {
      pingFailed = true;
    }
  }
  if (isLoading(wc)) return;
  if (
    shouldReloadAfterWakePing({
      crashed,
      childCount,
      pingFailed: probeUi ? pingFailed : false,
      loading: isLoading(wc),
    })
  ) {
    reloadWindowContents(win);
  }
}

function recoverTrackedWindows(probeUi: boolean) {
  for (const win of [...tracked]) {
    if (win.isDestroyed()) {
      tracked.delete(win);
      continue;
    }
    void recoverWindow(win, probeUi);
  }
}

function scheduleResumeRecovery() {
  if (resumeTimer) clearTimeout(resumeTimer);
  // Lid-close often leaves visibilityState === 'visible', so the renderer
  // never sees a focus event. Ping after a short GPU settle; reload only
  // when the tree is gone or the ping itself fails.
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    recoverTrackedWindows(true);
  }, 400);
}

export function attachWindowRecovery(win: BrowserWindow): void {
  tracked.add(win);
  const wc = windowWebContents(win);
  if (!wc) return;

  wc.on('render-process-gone', (_event, details) => {
    if (isLoading(wc)) return;
    if (!shouldReloadAfterRenderGone(details?.reason)) return;
    console.error('Renderer process gone', details);
    reloadWindowContents(win);
  });

  wc.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!shouldRetryFailedLoad(errorCode, isMainFrame !== false)) return;
      console.error('Renderer failed load', {
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );

  win.on('closed', () => {
    tracked.delete(win);
  });
}

export function installOsResumeRecovery(): void {
  if (powerHooked) return;
  powerHooked = true;

  try {
    powerMonitor.on('resume', () => scheduleResumeRecovery());
  } catch {
    // ignore — some test/headless hosts have no powerMonitor
  }

  try {
    app.on('child-process-gone', (_event, details) => {
      if (details?.type === 'GPU') scheduleResumeRecovery();
    });
  } catch {
    // ignore
  }
}
