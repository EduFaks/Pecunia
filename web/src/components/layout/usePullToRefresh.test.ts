import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { usePullToRefresh } from "./usePullToRefresh";

/** Stubs `window.scrollY` for a test — jsdom's own value is always 0, so this
 * is how a test simulates the page being scrolled down. */
function setWindowScrollY(value: number) {
  Object.defineProperty(window, "scrollY", { value, configurable: true, writable: true });
}

/** Mounts the hook wired to a plain `<div>` via `bind`, the same way
 * `Dashboard.tsx` wires it to its scroll container — `fireEvent.touchStart`/
 * `touchMove`/`touchEnd` on that node is how a real `<div {...bind}>` sees
 * touch events, and `refreshing` is rendered as text so it's assertable
 * without reaching into hook internals. Built with `createElement` (no JSX)
 * so this stays a plain `.test.ts` file, matching `usePullToRefresh.ts`. */
function Harness({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { bind, refreshing } = usePullToRefresh({ onRefresh });
  return createElement(
    "div",
    { "data-testid": "scroll-container", ...bind },
    refreshing ? "refreshing" : "idle",
  );
}

function pull(container: HTMLElement, distance: number) {
  fireEvent.touchStart(container, { touches: [{ clientY: 0 }] });
  fireEvent.touchMove(container, { touches: [{ clientY: distance }] });
  fireEvent.touchEnd(container, { changedTouches: [{ clientY: distance }] });
}

describe("usePullToRefresh", () => {
  afterEach(() => {
    setWindowScrollY(0);
  });

  it("does not call onRefresh when the page itself is scrolled down, even if the bound element reads scrollTop 0", () => {
    // Regression test: `AppShell`'s `<main>` has no `overflow-y-auto`, so the
    // real scroll container on this app is the document/window, not the
    // `<div>` the hook binds to — that div's own `scrollTop` is always 0.
    // A user scrolled deep into the page who drags down to scroll back up
    // must not spuriously trigger a refresh.
    setWindowScrollY(120);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(createElement(Harness, { onRefresh }));

    pull(screen.getByTestId("scroll-container"), 80);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("calls onRefresh once after a pull past the ~64px threshold is released", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(createElement(Harness, { onRefresh }));

    // `act`'s async form flushes the microtask `onRefresh().finally(...)`
    // schedules, so the resulting `setRefreshing(false)` isn't left
    // dangling outside React's update-batching after the test returns.
    await act(async () => {
      pull(screen.getByTestId("scroll-container"), 80);
      await Promise.resolve();
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not call onRefresh when the pull stays under the threshold", () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(createElement(Harness, { onRefresh }));

    pull(screen.getByTestId("scroll-container"), 20);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not call onRefresh when the container isn't scrolled to the top", () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(createElement(Harness, { onRefresh }));
    const container = screen.getByTestId("scroll-container");
    container.scrollTop = 40;

    pull(container, 80);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("toggles refreshing true while onRefresh is in flight, then back to false", async () => {
    let resolveRefresh: () => void = () => {};
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    render(createElement(Harness, { onRefresh }));
    const container = screen.getByTestId("scroll-container");
    expect(container).toHaveTextContent("idle");

    pull(container, 80);

    expect(container).toHaveTextContent("refreshing");

    await act(async () => {
      resolveRefresh();
      await Promise.resolve();
    });

    expect(container).toHaveTextContent("idle");
  });

  it("binds only touch handlers, so a mouse-only (desktop) interaction is a no-op", () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(createElement(Harness, { onRefresh }));
    const container = screen.getByTestId("scroll-container");

    fireEvent.mouseDown(container, { clientY: 0 });
    fireEvent.mouseMove(container, { clientY: 80 });
    fireEvent.mouseUp(container, { clientY: 80 });

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
