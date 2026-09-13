import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BudgetVsActualBar from "./BudgetVsActualBar";

function renderBar(props: { actualMinor: number | null; amountMinor: number; currency: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BudgetVsActualBar {...props} />
    </QueryClientProvider>,
  );
}

describe("BudgetVsActualBar", () => {
  it("renders no progress bar for a categoryless budget (actualMinor null)", () => {
    renderBar({ actualMinor: null, amountMinor: 60_000, currency: "USD" });

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/set a category to track spending/i)).toBeInTheDocument();
  });

  it("fills with the accent token and shows remaining when under budget", () => {
    const { container } = renderBar({ actualMinor: 30_000, amountMinor: 80_000, currency: "USD" });

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "38"); // 30_000 / 80_000, rounded
    const fill = container.querySelector("[data-budget-fill]") as HTMLElement;
    expect(fill.className).toMatch(/bg-accent/);
    expect(fill.className).not.toMatch(/bg-negative/);
    expect(screen.getByText(/remaining/i)).toBeInTheDocument();
    expect(screen.getByText(/300\.00/)).toBeInTheDocument();
    expect(screen.getByText(/500\.00/)).toBeInTheDocument();
  });

  it("switches the fill to the negative token and shows over-by when over budget", () => {
    const { container } = renderBar({ actualMinor: 90_000, amountMinor: 60_000, currency: "USD" });

    const fill = container.querySelector("[data-budget-fill]") as HTMLElement;
    expect(fill.className).toMatch(/bg-negative/);
    expect(fill.className).not.toMatch(/bg-accent\b/);
    expect(screen.getByText(/over by/i)).toBeInTheDocument();
    expect(screen.getByText(/300\.00/)).toBeInTheDocument();
  });
});
