import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Button from "./Button";

describe("Button", () => {
  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Save
      </Button>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows a loading indicator, marks aria-busy, and blocks clicks while loading", () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });

    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies the shared white focus-visible ring", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });

    expect(button.className).toMatch(/focus-visible:outline-focus/);
  });

  it("renders each variant without raw hex classes", () => {
    const { rerender } = render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole("button").className).not.toMatch(/#[0-9a-fA-F]{3,8}/);

    rerender(<Button variant="ghost">Go</Button>);
    expect(screen.getByRole("button").className).not.toMatch(/#[0-9a-fA-F]{3,8}/);

    rerender(<Button variant="quiet">Go</Button>);
    expect(screen.getByRole("button").className).not.toMatch(/#[0-9a-fA-F]{3,8}/);

    rerender(<Button variant="destructive">Go</Button>);
    expect(screen.getByRole("button").className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("gives the destructive variant a solid --pc-negative fill, for an irreversible action's confirm button", () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole("button").className).toMatch(/bg-negative/);
  });

  it("gives size=\"sm\" a taller, comfortable touch target on mobile (py-2.5) while reverting to the compact desktop height at sm: (py-1.5) — dense row actions (transactions, subscriptions, table rows) all use size=\"sm\"", () => {
    render(<Button size="sm">Edit</Button>);
    const className = screen.getByRole("button").className;
    expect(className).toMatch(/\bpy-2\.5\b/);
    expect(className).toMatch(/\bsm:py-1\.5\b/);
  });
});
