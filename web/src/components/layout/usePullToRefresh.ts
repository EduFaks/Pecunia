import { useCallback, useRef, useState } from "react";
import type { TouchEvent } from "react";

/** How far (px) a pull has to travel past the top before release triggers a
 * refresh — iOS's own pull-to-refresh affordance resolves at roughly this
 * distance, so this stays in the same ballpark rather than feeling twitchy
 * (too low) or unresponsive (too high). */
const PULL_THRESHOLD_PX = 64;

/** Whether the page itself (not just the bound element) is scrolled to the
 * top. This app scrolls via the document/window — `AppShell`'s `<main>` has
 * no `overflow-y-auto` — so the bound element's own `scrollTop` is always 0
 * regardless of how far down the page the user has scrolled; `window.scrollY`
 * is what actually reflects page position. */
function isPageAtTop(): boolean {
  if (typeof window !== "undefined" && typeof window.scrollY === "number") {
    return window.scrollY === 0;
  }
  return (document.documentElement?.scrollTop ?? 0) === 0;
}

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
 * Bound to one container (via `bind`'s `currentTarget`, so no ref plumbing
 * is needed): starting a touch arms the gesture only when the *page* is
 * scrolled to the top (`isPageAtTop()` — this app scrolls via the
 * document/window, not the bound element, so `window.scrollY === 0` is the
 * check that matters; the bound element's own `scrollTop === 0` is checked
 * too, as a harmless no-op belt-and-suspenders for the case it's ever
 * scrollable itself). Releasing after the finger has moved down past
 * `PULL_THRESHOLD_PX` from where it started calls `onRefresh`, with
 * `refreshing` true for as long as that promise is in flight. Starting the
 * drag while the page is scrolled down, or releasing short of the
 * threshold, does nothing.
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
      if (event.currentTarget.scrollTop > 0 || !isPageAtTop()) {
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
