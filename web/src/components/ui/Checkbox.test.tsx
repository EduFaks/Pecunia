import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChangeEvent } from "react";
import Checkbox from "./Checkbox";

describe("Checkbox", () => {
  it("associates the label with the checkbox input", () => {
    render(<Checkbox label="Show archived accounts" checked={false} onChange={() => {}} />);
    const checkbox = screen.getByLabelText("Show archived accounts");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("type", "checkbox");
  });

  it("reflects the controlled checked state and calls onChange with the new value", () => {
    // Captured inside the handler, like `Select.test.tsx`'s controlled-value
    // assertion: this harness is static (no state update), so React's
    // controlled-input contract snaps `checked` back to the prop right after
    // the change event.
    let observedChecked: boolean | undefined;
    const onChange = vi.fn((event: ChangeEvent<HTMLInputElement>) => {
      observedChecked = event.target.checked;
    });
    render(<Checkbox label="Show archived accounts" checked={false} onChange={onChange} />);
    const checkbox = screen.getByLabelText("Show archived accounts") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(observedChecked).toBe(true);
  });

  it("renders checked when the checked prop is true", () => {
    render(<Checkbox label="Show archived accounts" checked onChange={() => {}} />);
    expect(screen.getByLabelText("Show archived accounts")).toBeChecked();
  });

  it("applies the shared white focus-visible ring", () => {
    render(<Checkbox label="Show archived accounts" checked={false} onChange={() => {}} />);
    expect(screen.getByLabelText("Show archived accounts").className).toMatch(
      /focus-visible:outline-focus/,
    );
  });

  it("forwards a ref to the underlying input", () => {
    let node: HTMLInputElement | null = null;
    render(
      <Checkbox
        label="Show archived accounts"
        checked={false}
        onChange={() => {}}
        ref={(el) => {
          node = el;
        }}
      />,
    );
    expect(node).toBeInstanceOf(HTMLInputElement);
  });
});
