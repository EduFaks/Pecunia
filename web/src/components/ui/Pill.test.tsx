import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Pill from "./Pill";

describe("Pill", () => {
  it("renders its content", () => {
    render(<Pill>Monthly</Pill>);
    expect(screen.getByText("Monthly")).toBeInTheDocument();
  });

  it("defaults to the neutral tone, never the white accent", () => {
    render(<Pill>Active</Pill>);
    const pill = screen.getByText("Active");
    expect(pill.className).toMatch(/bg-surface-2/);
    expect(pill.className).not.toMatch(/accent/);
  });

  it("applies the positive (emerald) tone for a genuine semantic state", () => {
    render(<Pill tone="positive">Target reached</Pill>);
    expect(screen.getByText("Target reached").className).toMatch(/text-positive/);
  });
});
