import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import MonthResultCard from "./MonthResultCard";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const PREFERENCES = {
  base_currency: "USD",
  locale: "en-US",
  date_format: "MM/DD/YYYY",
  number_format: "1,234.56",
  timezone: "UTC",
  first_day_of_week: "monday",
};

// income(500.00) - committed(50.00) - spent(220.00) = safe(230.00) — a
// positive projection, mirroring SafeToSpendCard.test.tsx's fixture.
// projected_income/expense deliberately differ from SAVINGS' MTD actuals
// (550.00/240.00 vs 500.00/220.00) so tests can tell actual and projected
// figures apart.
const SAFE_ENTRY = {
  safe_minor: 23_000,
  displayed_safe_minor: 23_000,
  limited_by: "income" as const,
  expected_income_minor: 50_000,
  committed_remaining_minor: 5_000,
  spent_mtd_minor: 22_000,
  monthly_budget_minor: null,
  days_remaining: 10,
  daily_allowance_minor: 2_300,
  projected_income_minor: 55_000,
  projected_expense_minor: 24_000,
};

const SAVINGS = {
  income_minor: 50_000,
  spend_minor: 22_000,
  saved_minor: 28_000,
  rate_bps: 5_600,
  prev_saved_minor: 0,
  prev_rate_bps: 0,
};

function mockEndpoints(options: {
  savings?: Record<string, unknown> | null;
  safeToSpend?: Record<string, unknown> | null;
}) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/summary")) {
      return Promise.resolve(
        options.savings === null || options.savings === undefined
          ? {}
          : {
              USD: {
                savings: options.savings,
                committed_monthly: { total_minor: 0, subscriptions_minor: 0, loans_minor: 0, planned_minor: 0 },
                net_worth_change: {
                  now_minor: 0, start_of_month_minor: 0, delta_minor: 0, pct_bps: 0, movers: [],
                },
              },
            },
      );
    }
    if (path === "/analytics/safe-to-spend") {
      return Promise.resolve(
        options.safeToSpend === null || options.safeToSpend === undefined
          ? {}
          : { USD: options.safeToSpend },
      );
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MonthResultCard />
    </QueryClientProvider>,
  );
}

describe("MonthResultCard", () => {
  it("shows entrou/saiu from the summary's MTD savings figures", async () => {
    mockEndpoints({ savings: SAVINGS, safeToSpend: SAFE_ENTRY });

    renderCard();

    expect(await screen.findByText(/entrou/i)).toBeInTheDocument();
    expect(screen.getByText(/saiu/i)).toBeInTheDocument();
    expect(screen.getByText(/500\.00/)).toBeInTheDocument(); // income MTD
    expect(screen.getByText(/220\.00/)).toBeInTheDocument(); // spend MTD
  });

  it("shows a projected figure alongside each actual, in a muted tone", async () => {
    mockEndpoints({ savings: SAVINGS, safeToSpend: SAFE_ENTRY });

    renderCard();

    await screen.findByText(/entrou/i);

    // "(previsto …)" appears once per row (income + expense).
    const previstoNotes = screen.getAllByText(/previsto/i);
    expect(previstoNotes).toHaveLength(2);
    previstoNotes.forEach((note) => expect(note).toHaveClass("text-ink-faint"));

    // Projected figures (from useSafeToSpend) render in the muted tone...
    const projectedIncome = screen.getByText(/550\.00/);
    const projectedExpense = screen.getByText(/240\.00/);
    expect(projectedIncome).toHaveClass("text-ink-faint");
    expect(projectedExpense).toHaveClass("text-ink-faint");

    // ...while the actuals (from useSummary) stay in the primary tone.
    const actualIncome = screen.getByText(/500\.00/);
    const actualExpense = screen.getByText(/220\.00/);
    expect(actualIncome).not.toHaveClass("text-ink-faint");
    expect(actualExpense).not.toHaveClass("text-ink-faint");
  });

  it("still renders the projected figure when it equals the actual (nothing extra scheduled)", async () => {
    mockEndpoints({
      savings: SAVINGS,
      safeToSpend: { ...SAFE_ENTRY, projected_income_minor: 50_000, projected_expense_minor: 22_000 },
    });

    renderCard();

    await screen.findByText(/entrou/i);

    // Even though projected === actual for both rows, the "(previsto …)"
    // note must still render rather than being hidden as redundant.
    expect(screen.getAllByText(/previsto/i)).toHaveLength(2);
    // Two elements now render "500.00" (actual + projected income), and
    // two render "220.00" (actual + projected expense).
    expect(screen.getAllByText(/500\.00/)).toHaveLength(2);
    expect(screen.getAllByText(/220\.00/)).toHaveLength(2);
  });

  it("shows a green, signed end-of-month projection reused from SafeToSpend when non-negative", async () => {
    mockEndpoints({ savings: SAVINGS, safeToSpend: SAFE_ENTRY });

    const { container } = renderCard();

    expect(await screen.findByText(/projeção fim do mês/i)).toBeInTheDocument();
    // safe_minor = income(500) - committed(50) - spent(220) = 230.00
    const projectionEl = screen.getByText(/230\.00/);
    expect(projectionEl).toHaveClass("text-positive");
    expect(container.querySelector(".text-negative")).toBeNull();
  });

  it("shows a red projection when the SafeToSpend-derived figure is negative", async () => {
    mockEndpoints({
      savings: SAVINGS,
      safeToSpend: { ...SAFE_ENTRY, safe_minor: -1_500, displayed_safe_minor: -1_500 },
    });

    renderCard();

    const projectionEl = await screen.findByText(/-?\$?15\.00/);
    expect(projectionEl).toHaveClass("text-negative");
  });

  it("shows a calm empty state when the base currency has no data", async () => {
    mockEndpoints({ savings: null, safeToSpend: null });

    renderCard();

    expect(await screen.findByText(/sem dados/i)).toBeInTheDocument();
  });

  it("shows an error state when a query fails", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      return Promise.reject(new Error("boom"));
    });

    renderCard();

    expect(await screen.findByText(/não foi possível/i)).toBeInTheDocument();
  });
});
