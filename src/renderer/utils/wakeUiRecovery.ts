/**
 * Reload when the React tree has vanished after a wake.
 *
 * Tablets (no Electron `powerMonitor`) and Vite HMR both unmount `#root`
 * without throwing into ErrorBoundary. The main process also pings via
 * `pos:os-resume` after OS sleep — this is the fallback when that ping
 * never arrives.
 *
 * Do not hook `focus` / `pageshow` / `online`: those fire on a normal
 * Cmd+R while `#root` is empty between `createRoot` and the first paint,
 * which reloads the page into a blank Electron window.
 */

import {
  isRendererUiBlank,
  shouldReloadBlankOnWake,
  type RendererUiSnapshot,
} from '@shared/wakeRecovery';

const RELOAD_GUARD_KEY = 'pos-wake-ui-reload-at';
const RELOAD_GUARD_MS = 8_000;
/** Don't treat createRoot's empty swap as a crashed UI. */
const BLANK_RELOAD_GRACE_MS = 4_000;

function recentlyReloaded(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    return Number.isFinite(at) && now - at < RELOAD_GUARD_MS;
  } catch {
    return false;
  }
}

function markReload(now = Date.now()): void {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
  } catch {
    // ignore
  }
}

function readSnapshot(everPaintedUi: boolean): RendererUiSnapshot {
  const root = document.getElementById('root');
  const rect = root?.getBoundingClientRect();
  return {
    hasRoot: Boolean(root),
    childCount: root?.childElementCount ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    everPaintedUi,
  };
}

export function installWakeUiRecovery(opts?: {
  reload?: () => void;
}): () => void {
  const reload = opts?.reload ?? (() => window.location.reload());
  let everPaintedUi = false;
  let armed = false;
  let graceOver = false;
  let wasHidden = document.visibilityState === 'hidden';
  const graceTimer = window.setTimeout(() => {
    graceOver = true;
  }, BLANK_RELOAD_GRACE_MS);

  const markIfPainted = () => {
    const snap = readSnapshot(true);
    if (!isRendererUiBlank(snap)) everPaintedUi = true;
  };

  const recoverIfBlank = (signal: {
    fromOsResume?: boolean;
    wasHidden?: boolean;
  }) => {
    if (!graceOver) {
      markIfPainted();
      return;
    }
    markIfPainted();
    if (
      !shouldReloadBlankOnWake({
        visibilityState: document.visibilityState,
        snapshot: readSnapshot(everPaintedUi),
        fromOsResume: signal.fromOsResume,
        wasHidden: signal.wasHidden,
      })
    ) {
      return;
    }
    if (armed || recentlyReloaded()) return;
    armed = true;
    markReload();
    reload();
  };

  const onVisible = () => {
    const hidden = document.visibilityState === 'hidden';
    if (wasHidden && !hidden) recoverIfBlank({ wasHidden: true });
    wasHidden = hidden;
  };

  markIfPainted();

  const root = document.getElementById('root');
  const mo =
    root && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(markIfPainted)
      : null;
  mo?.observe(root!, { childList: true });

  const onOsResume = () => recoverIfBlank({ fromOsResume: true });

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pos:os-resume', onOsResume);

  return () => {
    window.clearTimeout(graceTimer);
    mo?.disconnect();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pos:os-resume', onOsResume);
  };
}
