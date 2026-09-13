import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChangeEvent } from "react";
import Select from "./Select";

const OPTIONS = [
  { value: "monday", label: "Monday" },
  { value: "sunday", label: "Sunday" },
];

describe("Select", () => {
  it("associates the label with the select and renders every option", () => {
    render(<Select label="First day of week" options={OPTIONS} value="monday" onChange={() => {}} />);
    const select = screen.getByLabelText("First day of week");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Monday" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sunday" })).toBeInTheDocument();
  });

  it("reflects the controlled value and calls onChange with the new value", () => {
    // Captured inside the handler itself, not read back off `event.target`
    // afterward: `target` is a live DOM node, and since this harness is
    // static (no state update), React's controlled-input contract snaps the
    // select's displayed value back to the `value` prop right after the
    // change event — the same way it would for an un-wired TextField/
    // PasswordField onChange.
    let observedValue: string | undefined;
    const onChange = vi.fn((event: ChangeEvent<HTMLSelectElement>) => {
      observedValue = event.target.value;
    });
    render(<Select label="First day of week" options={OPTIONS} value="monday" onChange={onChange} />);
    const select = screen.getByLabelText("First day of week") as HTMLSelectElement;
    expect(select.value).toBe("monday");

    fireEvent.change(select, { target: { value: "sunday" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(observedValue).toBe("sunday");
  });

  it("renders a description and wires it via aria-describedby", () => {
    render(
      <Select
        label="Timezone"
        description="Used for scheduling and display."
        options={OPTIONS}
        value="monday"
        onChange={() => {}}
      />,
    );
    const select = screen.getByLabelText("Timezone");
    const description = screen.getByText("Used for scheduling and display.");
    expect(select.getAttribute("aria-describedby")).toContain(description.id);
  });

  it("renders an error via an accessible alert and marks the select invalid", () => {
    render(
      <Select label="Timezone" options={OPTIONS} value="monday" onChange={() => {}} error="Required" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
    expect(screen.getByLabelText("Timezone")).toHaveAttribute("aria-invalid", "true");
  });

  it("applies the shared white focus-visible ring", () => {
    render(<Select label="Timezone" options={OPTIONS} value="monday" onChange={() => {}} />);
    expect(screen.getByLabelText("Timezone").className).toMatch(/focus-visible:outline-focus/);
  });
});
