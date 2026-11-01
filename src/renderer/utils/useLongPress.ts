import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { haptic } from './haptics';

/** A finger that moves this far is scrolling, not holding. */
const MOVE_TOLERANCE_PX = 12;

/**
 * Press-and-hold on an element. Spread `handlers` on it; call
 * `consumeClick()` first thing in its onClick so the release that ends a
 * completed hold is not also treated as a tap.
 */
export function useLongPress(
  onLongPress: (() => void) | undefined,
  holdMs: number,
) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  useEffect(() => cancel, []);

  const handlers = onLongPress
    ? {
        onPointerDown: (e: ReactPointerEvent) => {
          if (e.button !== 0) return;
          cancel();
          fired.current = false;
          start.current = { x: e.clientX, y: e.clientY };
          timer.current = window.setTimeout(() => {
            timer.current = null;
            start.current = null;
            fired.current = true;
            haptic('heavy');
            callback.current?.();
          }, holdMs);
        },
        onPointerMove: (e: ReactPointerEvent) => {
          const s = start.current;
          if (!s) return;
          if (
            Math.abs(e.clientX - s.x) > MOVE_TOLERANCE_PX ||
            Math.abs(e.clientY - s.y) > MOVE_TOLERANCE_PX
          ) {
            cancel();
          }
        },
        onPointerUp: cancel,
        onPointerLeave: cancel,
        onPointerCancel: cancel,
        // A long touch would otherwise open the system context menu.
        onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
      }
    : {};

  /** True (and reset) when this click is the release of a completed hold. */
  const consumeClick = () => {
    if (!fired.current) return false;
    fired.current = false;
    return true;
  };

  return { handlers, consumeClick };
}
