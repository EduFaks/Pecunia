import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PeriodSelector } from "./PeriodSelector";

describe("PeriodSelector", () => {
  it("offers the 3/6/12/24-month windows plus All time, marking the active choice", () => {
    render(<PeriodSelector value={{ kind: "months", months: 12 }} onChange={() => {}} />);

    for (const name of ["3 months", "6 months", "12 months", "24 months", "All time"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "12 months" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All time" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("emits a months selection for a bounded window and an all selection for All time", () => {
    const onChange = vi.fn();
    render(<PeriodSelector value={{ kind: "months", months: 12 }} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "24 months" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "months", months: 24 });

    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "all" });
  });

  it("marks All time pressed when selected", () => {
    render(<PeriodSelector value={{ kind: "all" }} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "All time" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hides the All time option for screens whose endpoint has no all-time read", () => {
    render(
      <PeriodSelector
        value={{ kind: "months", months: 12 }}
        onChange={() => {}}
        includeAllTime={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "All time" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "24 months" })).toBeInTheDocument();
  });

  it("wraps its up-to-5 toggles onto a second line instead of overflowing a narrow (360px) viewport", () => {
    render(<PeriodSelector value={{ kind: "months", months: 12 }} onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Reporting period" }).className).toMatch(
      /\bflex-wrap\b/,
    );
  });
});
