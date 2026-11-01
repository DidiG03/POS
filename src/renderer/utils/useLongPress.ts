import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { haptic } from './haptics';

/** A finger that moves this far is not holding still. */
const MOVE_TOLERANCE_PX = 24;

/**
 * Press-and-hold on an element. Spread `handlers` on it and call
 * `consumeClick()` first thing in its onClick, so the release that ends a
 * completed hold is not also treated as a tap. `holding` is true while a
 * hold is in progress (for a progress indicator).
 *
 * Touch screens: a long finger press is something the browser wants for
 * itself (text selection, the context menu, scrolling), and when it takes
 * the gesture it sends `pointercancel`. `touch-action: none` and pointer
 * capture keep the gesture with us, so only lifting or moving the finger
 * ends the hold.
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
  const [holding, setHolding] = useState(false);

  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
    setHolding(false);
  };

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  const handlers = onLongPress
    ? {
        style: {
          touchAction: 'none',
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        } as const,
        onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          cancel();
          fired.current = false;
          start.current = { x: e.clientX, y: e.clientY };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Not fatal: the hold still works without capture.
          }
          setHolding(true);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            start.current = null;
            fired.current = true;
            setHolding(false);
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
        onPointerCancel: cancel,
        // A long touch would otherwise open the system context menu.
        onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
        onDragStart: (e: ReactMouseEvent) => e.preventDefault(),
      }
    : {};

  /** True (and reset) when this click is the release of a completed hold. */
  const consumeClick = () => {
    if (!fired.current) return false;
    fired.current = false;
    return true;
  };

  return { handlers, consumeClick, holding };
}
