import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders the title and description as an accessible alertdialog", () => {
    render(
      <ConfirmDialog
        title='Delete "Emergency fund"?'
        description="This can't be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName('Delete "Emergency fund"?');
    expect(dialog).toHaveAccessibleDescription("This can't be undone.");
  });

  it("moves focus to Cancel on mount, never the destructive Confirm", () => {
    render(<ConfirmDialog title="Delete this?" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("calls onConfirm and not onCancel when the confirm action is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete this?"
        confirmLabel="Delete forever"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel and not onConfirm when Cancel is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Delete this?" onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel when Escape is pressed", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Delete this?" onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus within the dialog, wrapping from the last to the first focusable element", () => {
    render(<ConfirmDialog title="Delete this?" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const confirmButton = screen.getByRole("button", { name: "Delete" });
    confirmButton.focus();
    expect(confirmButton).toHaveFocus();

    fireEvent.keyDown(confirmButton, { key: "Tab" });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(cancelButton, { key: "Tab", shiftKey: true });
    expect(confirmButton).toHaveFocus();
  });

  it("styles the confirm action with the negative token, not a raw hex value", () => {
    render(<ConfirmDialog title="Delete this?" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const confirmButton = screen.getByRole("button", { name: "Delete" });
    expect(confirmButton.className).toMatch(/bg-negative/);
    expect(confirmButton.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("disables both actions and shows the confirm action as busy while isConfirming", () => {
    render(<ConfirmDialog title="Delete this?" onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming />);

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-busy", "true");
  });
});
