import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FundingBar from "./FundingBar";
import type { ProjectType } from "./projectTypes";

function renderBar(
  actualMinor: number,
  targetAmountMinor: number | null,
  type: ProjectType = "spending",
  currency = "USD",
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FundingBar
        actualMinor={actualMinor}
        targetAmountMinor={targetAmountMinor}
        type={type}
        currency={currency}
      />
    </QueryClientProvider>,
  );
}

describe("FundingBar", () => {
  it("shows the actual and target amounts", () => {
    renderBar(500_000, 1_000_000);
    expect(screen.getByText(/5,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/10,000\.00/)).toBeInTheDocument();
  });

  it("renders a progressbar sized to the actual percentage, filled with the white accent", () => {
    renderBar(500_000, 1_000_000);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    const fill = bar.querySelector("[data-funding-fill]");
    expect(fill).toHaveClass("bg-accent");
    expect(fill).toHaveStyle({ width: "50%" });
  });

  it("uses spending vocabulary (spent / budget) for a spending project", () => {
    renderBar(500_000, 1_000_000, "spending");
    expect(screen.getByText(/spent/i)).toBeInTheDocument();
    expect(screen.getByText(/of budget/i)).toBeInTheDocument();
  });

  it("uses saving vocabulary (saved / goal) for a saving project", () => {
    renderBar(500_000, 1_000_000, "saving");
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
    expect(screen.getByText(/of goal/i)).toBeInTheDocument();
  });

  it("switches a spending project past its budget to the negative fill and an over-budget pill", () => {
    renderBar(1_500_000, 1_000_000, "spending");
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar.querySelector("[data-funding-fill]")).toHaveClass("bg-negative");
    expect(screen.getByText(/over budget/i)).toBeInTheDocument();
    expect(screen.queryByText(/goal reached/i)).not.toBeInTheDocument();
  });

  it("keeps a saving project at (and past) its goal on the accent fill with a goal-reached pill", () => {
    renderBar(1_500_000, 1_000_000, "saving");
    const bar = screen.getByRole("progressbar");
    expect(bar.querySelector("[data-funding-fill]")).toHaveClass("bg-accent");
    expect(screen.getByText(/goal reached/i)).toBeInTheDocument();
    expect(screen.queryByText(/over budget/i)).not.toBeInTheDocument();
  });

  it("shows a goal-reached pill for a saving project exactly at its goal", () => {
    renderBar(1_000_000, 1_000_000, "saving");
    expect(screen.getByText(/goal reached/i)).toBeInTheDocument();
  });

  it("does not show any badge below the target", () => {
    renderBar(500_000, 1_000_000, "spending");
    expect(screen.queryByText(/over budget/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/goal reached/i)).not.toBeInTheDocument();
  });

  it("shows no positive 'goal reached' pill for a spending project exactly at its budget", () => {
    // Hitting a budget dead-on isn't a celebration — and it isn't over budget
    // either (that's strictly-past only), so no pill of either tone renders.
    renderBar(1_000_000, 1_000_000, "spending");
    expect(screen.queryByText(/goal reached/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/over budget/i)).not.toBeInTheDocument();
  });

  it("renders a no-target state without a progressbar when there is no target amount", () => {
    renderBar(500_000, null, "spending");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/no budget set/i)).toBeInTheDocument();
  });
});
