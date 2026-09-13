import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import SavingsRateCard from "./SavingsRateCard";

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

function mockSummary(response: unknown) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/summary")) {
      return Promise.resolve(response);
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SavingsRateCard />
    </QueryClientProvider>,
  );
}

describe("SavingsRateCard", () => {
  it("shows the saved amount, rate, and an up trend against the prior month", async () => {
    mockSummary({
      USD: {
        savings: {
          income_minor: 10_000, spend_minor: 4_000, saved_minor: 6_000, rate_bps: 6_000,
          prev_saved_minor: 0, prev_rate_bps: 0,
        },
        committed_monthly: { total_minor: 0, subscriptions_minor: 0, loans_minor: 0, planned_minor: 0 },
        net_worth_change: {
          now_minor: 0, start_of_month_minor: 0, delta_minor: 0, pct_bps: 0, movers: [],
        },
      },
    });

    renderCard();

    expect(await screen.findByRole("heading", { name: /savings rate/i })).toBeInTheDocument();
    expect(await screen.findByText(/60\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/60\.00/)).toBeInTheDocument(); // $60.00 saved
    // Trending up vs. the prior month's 0.0% rate.
    expect(screen.getByText(/vs 0\.0% last month/i)).toBeInTheDocument();
  });

  it("shows a down trend when the rate fell versus the prior month", async () => {
    mockSummary({
      USD: {
        savings: {
          income_minor: 10_000, spend_minor: 9_000, saved_minor: 1_000, rate_bps: 1_000,
          prev_saved_minor: 5_000, prev_rate_bps: 5_000,
        },
        committed_monthly: { total_minor: 0, subscriptions_minor: 0, loans_minor: 0, planned_minor: 0 },
        net_worth_change: {
          now_minor: 0, start_of_month_minor: 0, delta_minor: 0, pct_bps: 0, movers: [],
        },
      },
    });

    const { container } = renderCard();

    await screen.findByText(/10\.0%/);
    expect(container.querySelector(".lucide-trending-down")).not.toBeNull();
  });

  it("shows a calm empty state when there's no income or spending this month yet", async () => {
    mockSummary({
      USD: {
        savings: {
          income_minor: 0, spend_minor: 0, saved_minor: 0, rate_bps: 0,
          prev_saved_minor: 0, prev_rate_bps: 0,
        },
        committed_monthly: { total_minor: 0, subscriptions_minor: 0, loans_minor: 0, planned_minor: 0 },
        net_worth_change: {
          now_minor: 0, start_of_month_minor: 0, delta_minor: 0, pct_bps: 0, movers: [],
        },
      },
    });

    renderCard();

    expect(
      await screen.findByText(/no income or spending recorded this month yet/i),
    ).toBeInTheDocument();
  });

  it("shows a calm empty state when the base currency is absent from the response", async () => {
    mockSummary({});

    renderCard();

    expect(
      await screen.findByText(/no income or spending recorded this month yet/i),
    ).toBeInTheDocument();
  });
});
