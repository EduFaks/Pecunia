import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { usePullToRefresh } from "./usePullToRefresh";

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
