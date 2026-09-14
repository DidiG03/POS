/**
 * Decide when a POS window that went blank after sleep/crash should reload.
 *
 * Chromium (and Vite HMR in `npm run dev`) can leave the Electron window
 * showing only `backgroundColor` after a laptop lid-close: the renderer
 * process is gone, the compositor never paints again, or React unmounted
 * and `#root` is empty. Staff must not be stuck on a navy screen until
 * they know to refresh.
 */

/** Chromium `did-fail-load` code for a navigation that was superseded. */
export const ERR_ABORTED = -3;

/** Probe/reload after this much wall-clock idle (sleep, hang, or lid-close). */
export const WAKE_PROBE_AFTER_MS = 2 * 60 * 1000;

const MIN_PAINTED_PX = 8;

export type RendererUiSnapshot = {
  hasRoot: boolean;
  childCount: number;
  width: number;
  height: number;
  everPaintedUi: boolean;
};

export function shouldReloadAfterRenderGone(
  reason: string | undefined | null,
): boolean {
  return String(reason || '') !== 'clean-exit';
}

export function shouldRetryFailedLoad(
  errorCode: number,
  isMainFrame = true,
): boolean {
  if (!isMainFrame) return false;
  if (errorCode === 0 || errorCode === ERR_ABORTED) return false;
  return true;
}

export function isRendererUiBlank(
  snap: Omit<RendererUiSnapshot, 'everPaintedUi'>,
): boolean {
  if (!snap.hasRoot) return true;
  if (snap.childCount <= 0) return true;
  if (snap.width < MIN_PAINTED_PX || snap.height < MIN_PAINTED_PX) return true;
  return false;
}

export function shouldReloadBlankRenderer(snap: RendererUiSnapshot): boolean {
  return snap.everPaintedUi && isRendererUiBlank(snap);
}

export function shouldProbeRendererAfterSleep(idleMs: number): boolean {
  return Number.isFinite(idleMs) && idleMs >= WAKE_PROBE_AFTER_MS;
}

export function shouldReloadAfterWakePing(input: {
  crashed?: boolean;
  childCount?: number | null;
  pingFailed?: boolean;
  loading?: boolean;
}): boolean {
  if (input.loading) return false;
  if (input.crashed) return true;
  if (input.pingFailed) return true;
  // executeJavaScript returns -1 while the document is still booting.
  if (input.childCount === -1) return false;
  if (typeof input.childCount === 'number' && input.childCount < 1) return true;
  return false;
}

export function shouldReloadBlankOnWake(input: {
  visibilityState: string;
  snapshot: RendererUiSnapshot;
  /** Main-process `powerMonitor.resume` ping. */
  fromOsResume?: boolean;
  /** Document was hidden and is visible again (tablet / minimize). */
  wasHidden?: boolean;
}): boolean {
  if (input.visibilityState === 'hidden') return false;
  if (!input.fromOsResume && !input.wasHidden) return false;
  return shouldReloadBlankRenderer(input.snapshot);
}
