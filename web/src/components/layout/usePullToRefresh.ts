import { useCallback, useRef, useState } from "react";
import type { TouchEvent } from "react";

/** How far (px) a pull has to travel past the top before release triggers a
 * refresh — iOS's own pull-to-refresh affordance resolves at roughly this
 * distance, so this stays in the same ballpark rather than feeling twitchy
 * (too low) or unresponsive (too high). */
const PULL_THRESHOLD_PX = 64;

export interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void>;
}

export interface UsePullToRefreshBind {
  onTouchStart: (event: TouchEvent<HTMLElement>) => void;
  onTouchMove: (event: TouchEvent<HTMLElement>) => void;
  onTouchEnd: (event: TouchEvent<HTMLElement>) => void;
}

export interface UsePullToRefreshResult {
  /** Spread onto the scrollable container: `<div {...bind}>`. Touch-only —
   * there's deliberately no `onMouseDown`/`onPointerDown` pairing, so a
   * mouse-driven (desktop) drag is a structural no-op rather than something
   * a `scrollTop`/distance check has to reject. */
  bind: UsePullToRefreshBind;
  refreshing: boolean;
}

/**
 * A minimal, dependency-free pull-to-refresh gesture for a touch screen.
 * Bound to one scrollable container (via `bind`'s `currentTarget`, so no ref
 * plumbing is needed): starting a touch while that container reads
 * `scrollTop === 0` arms the gesture; releasing after the finger has moved
 * down past `PULL_THRESHOLD_PX` from where it started calls `onRefresh`,
 * with `refreshing` true for as long as that promise is in flight. Starting
 * the drag anywhere else (content already scrolled) or releasing short of
 * the threshold does nothing.
 *
 * Distance is measured between the `touchstart` Y and the latest known
 * finger Y (updated on every `touchmove`, falling back to `touchend`'s
 * `changedTouches` if a move was somehow never seen) — not accumulated
 * frame-by-frame — which is all `Dashboard.tsx`'s "pull down, release"
 * gesture needs and keeps the state machine to two refs.
 */
export function usePullToRefresh({ onRefresh }: UsePullToRefreshOptions): UsePullToRefreshResult {
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const lastY = useRef<number | null>(null);

  const reset = useCallback(() => {
    startY.current = null;
    lastY.current = null;
  }, []);

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      if (event.currentTarget.scrollTop > 0) {
        reset();
        return;
      }
      const touch = event.touches[0];
      startY.current = touch ? touch.clientY : null;
      lastY.current = startY.current;
    },
    [reset],
  );

  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      if (startY.current === null) {
        return;
      }
      // The container scrolled away from the top mid-gesture (the page
      // caught up with the finger) — abandon the pull rather than fire a
      // refresh from a stale starting point.
      if (event.currentTarget.scrollTop > 0) {
        reset();
        return;
      }
      const touch = event.touches[0];
      if (touch) {
        lastY.current = touch.clientY;
      }
    },
    [reset],
  );

  const onTouchEnd = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      if (startY.current === null) {
        reset();
        return;
      }
      const touch = event.changedTouches[0];
      const endY = touch ? touch.clientY : lastY.current;
      const distance = endY === null ? 0 : endY - startY.current;
      reset();

      if (distance <= PULL_THRESHOLD_PX) {
        return;
      }
      setRefreshing(true);
      void onRefresh().finally(() => setRefreshing(false));
    },
    [onRefresh, reset],
  );

  return { bind: { onTouchStart, onTouchMove, onTouchEnd }, refreshing };
}
