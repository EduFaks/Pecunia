import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

function Bomb(): never {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("renders a calm fallback instead of a blank page when a child throws", () => {
    // A component intentionally throwing during render logs via React's own
    // dev-mode console.error reporting — expected here, per CONVENTIONS
    // §9.10, scoped to this one test.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByText("PECUNIA")).toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByText("All good")).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it("reloads the page when Reload is clicked", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const originalLocation = window.location;
    // jsdom's window.location isn't directly assignable — replace the whole
    // property for the duration of this test, then restore it.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));

    expect(reload).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    consoleSpy.mockRestore();
  });
});
