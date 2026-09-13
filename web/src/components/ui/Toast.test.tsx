import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast";

function TriggerToast() {
  const { showToast } = useToast();
  return (
    <button type="button" onClick={() => showToast("Saved.", { variant: "positive" })}>
      Trigger
    </button>
  );
}

describe("ToastProvider / useToast", () => {
  it("shows a toast on demand and dismisses it via its close control", () => {
    render(
      <ToastProvider>
        <TriggerToast />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getByText("Saved.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it("renders an optional action button, invokes it, and dismisses the toast on click", () => {
    const onUndo = vi.fn();
    function TriggerActionToast() {
      const { showToast } = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            showToast("Transaction deleted.", { action: { label: "Undo", onClick: onUndo } })
          }
        >
          Trigger
        </button>
      );
    }

    render(
      <ToastProvider>
        <TriggerActionToast />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getByText("Transaction deleted.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Transaction deleted.")).not.toBeInTheDocument();
  });

  it("renders no action button when none is given", () => {
    render(
      <ToastProvider>
        <TriggerToast />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getAllByRole("button")).toHaveLength(2); // Trigger + Dismiss only
  });

  describe("outside a ToastProvider", () => {
    // React logs the thrown render error to console.error (and jsdom's
    // virtual console reports the resulting "Uncaught" window error the
    // same way) even though this test catches it — expected noise for a
    // deliberate error-boundary-less throw, not a real warning. Silenced
    // here so it doesn't pollute test output.
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    it("throws when useToast is used outside a ToastProvider", () => {
      function Bare() {
        useToast();
        return null;
      }
      expect(() => render(<Bare />)).toThrow(/ToastProvider/);
    });
  });
});
