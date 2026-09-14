import { describe, expect, it } from 'vitest';
import {
  ERR_ABORTED,
  WAKE_PROBE_AFTER_MS,
  isRendererUiBlank,
  shouldProbeRendererAfterSleep,
  shouldReloadAfterRenderGone,
  shouldReloadAfterWakePing,
  shouldReloadBlankOnWake,
  shouldReloadBlankRenderer,
  shouldRetryFailedLoad,
} from './wakeRecovery';

const painted = {
  hasRoot: true,
  childCount: 2,
  width: 1280,
  height: 800,
};

describe('wakeRecovery', () => {
  it('reloads crashed renderers but not a clean window close', () => {
    expect(shouldReloadAfterRenderGone('crashed')).toBe(true);
    expect(shouldReloadAfterRenderGone('oom')).toBe(true);
    expect(shouldReloadAfterRenderGone('killed')).toBe(true);
    expect(shouldReloadAfterRenderGone(undefined)).toBe(true);
    expect(shouldReloadAfterRenderGone('clean-exit')).toBe(false);
  });

  it('does not treat aborted navigations as load failures', () => {
    expect(shouldRetryFailedLoad(-102, true)).toBe(true);
    expect(shouldRetryFailedLoad(ERR_ABORTED, true)).toBe(false);
    expect(shouldRetryFailedLoad(-102, false)).toBe(false);
    expect(shouldRetryFailedLoad(0, true)).toBe(false);
  });

  it('treats an empty or collapsed #root as a blank UI', () => {
    expect(isRendererUiBlank({ ...painted })).toBe(false);
    expect(isRendererUiBlank({ ...painted, childCount: 0 })).toBe(true);
    expect(isRendererUiBlank({ ...painted, hasRoot: false })).toBe(true);
    expect(isRendererUiBlank({ ...painted, width: 0, height: 0 })).toBe(true);
  });

  it('only reloads a blank tree after the UI has painted once', () => {
    expect(
      shouldReloadBlankRenderer({
        ...painted,
        childCount: 0,
        everPaintedUi: false,
      }),
    ).toBe(false);
    expect(
      shouldReloadBlankRenderer({
        ...painted,
        childCount: 0,
        everPaintedUi: true,
      }),
    ).toBe(true);
  });

  it('does not reload a hidden tab that happens to be empty', () => {
    expect(
      shouldReloadBlankOnWake({
        visibilityState: 'hidden',
        snapshot: { ...painted, childCount: 0, everPaintedUi: true },
        wasHidden: true,
      }),
    ).toBe(false);
  });

  it('reloads a blank tree only after a real wake, not a Cmd+R refresh', () => {
    const blank = {
      ...painted,
      childCount: 0,
      everPaintedUi: true,
    };
    expect(
      shouldReloadBlankOnWake({
        visibilityState: 'visible',
        snapshot: blank,
      }),
    ).toBe(false);
    expect(
      shouldReloadBlankOnWake({
        visibilityState: 'visible',
        snapshot: blank,
        wasHidden: true,
      }),
    ).toBe(true);
    expect(
      shouldReloadBlankOnWake({
        visibilityState: 'visible',
        snapshot: blank,
        fromOsResume: true,
      }),
    ).toBe(true);
  });

  it('probes the renderer after a long sleep, not a brief lid-flap', () => {
    expect(shouldProbeRendererAfterSleep(5_000)).toBe(false);
    expect(shouldProbeRendererAfterSleep(WAKE_PROBE_AFTER_MS)).toBe(true);
    expect(shouldProbeRendererAfterSleep(8 * 60 * 60 * 1000)).toBe(true);
  });

  it('reloads when the wake ping finds a dead or empty renderer', () => {
    expect(shouldReloadAfterWakePing({ childCount: 3 })).toBe(false);
    expect(shouldReloadAfterWakePing({ childCount: 0 })).toBe(true);
    expect(shouldReloadAfterWakePing({ pingFailed: true, childCount: 4 })).toBe(
      true,
    );
    expect(shouldReloadAfterWakePing({ crashed: true, childCount: 4 })).toBe(
      true,
    );
    expect(shouldReloadAfterWakePing({ childCount: 0, loading: true })).toBe(
      false,
    );
    expect(shouldReloadAfterWakePing({ childCount: -1 })).toBe(false);
  });
});
