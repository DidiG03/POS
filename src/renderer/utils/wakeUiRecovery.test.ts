import { describe, expect, it } from 'vitest';
import { shouldReloadBlankOnWake } from '@shared/wakeRecovery';

describe('wake UI recovery', () => {
  it('reloads after the UI had painted and #root is later empty', () => {
    expect(
      shouldReloadBlankOnWake({
        visibilityState: 'visible',
        snapshot: {
          hasRoot: true,
          childCount: 0,
          width: 1280,
          height: 800,
          everPaintedUi: true,
        },
        fromOsResume: true,
      }),
    ).toBe(true);
  });

  it('leaves a healthy tree alone on wake', () => {
    expect(
      shouldReloadBlankOnWake({
        visibilityState: 'visible',
        snapshot: {
          hasRoot: true,
          childCount: 3,
          width: 1280,
          height: 800,
          everPaintedUi: true,
        },
        fromOsResume: true,
      }),
    ).toBe(false);
  });

  it('does not reload just because Cmd+R emptied #root', () => {
    expect(
      shouldReloadBlankOnWake({
        visibilityState: 'visible',
        snapshot: {
          hasRoot: true,
          childCount: 0,
          width: 1280,
          height: 800,
          everPaintedUi: true,
        },
      }),
    ).toBe(false);
  });
});
