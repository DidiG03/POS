import { describe, expect, it } from 'vitest';
import {
  OVERLAY_BACKDROP_GUARD_MS,
  shouldIgnoreOverlayBackdrop,
} from './Modal';

describe('shouldIgnoreOverlayBackdrop', () => {
  it('swallows the ghost click iOS retargets onto a just-opened overlay', () => {
    const openedAt = 1_000;
    expect(shouldIgnoreOverlayBackdrop(openedAt, openedAt + 50)).toBe(true);
    expect(
      shouldIgnoreOverlayBackdrop(
        openedAt,
        openedAt + OVERLAY_BACKDROP_GUARD_MS - 1,
      ),
    ).toBe(true);
  });

  it('lets a later backdrop tap dismiss', () => {
    const openedAt = 1_000;
    expect(
      shouldIgnoreOverlayBackdrop(
        openedAt,
        openedAt + OVERLAY_BACKDROP_GUARD_MS,
      ),
    ).toBe(false);
    expect(shouldIgnoreOverlayBackdrop(0, 1_500)).toBe(false);
  });
});
