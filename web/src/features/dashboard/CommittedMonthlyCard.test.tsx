import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import CommittedMonthlyCard from "./CommittedMonthlyCard";

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
      <CommittedMonthlyCard />
    </QueryClientProvider>,
  );
}

describe("CommittedMonthlyCard", () => {
  it("shows the total and the three-way breakdown", async () => {
    mockSummary({
      USD: {
        savings: {
          income_minor: 0, spend_minor: 0, saved_minor: 0, rate_bps: 0,
          prev_saved_minor: 0, prev_rate_bps: 0,
        },
        committed_monthly: {
          total_minor: 10_200, subscriptions_minor: 5_200, loans_minor: 3_000, planned_minor: 2_000,
        },
        net_worth_change: {
          now_minor: 0, start_of_month_minor: 0, delta_minor: 0, pct_bps: 0, movers: [],
        },
      },
    });

    renderCard();

    expect(await screen.findByRole("heading", { name: /committed monthly cost/i })).toBeInTheDocument();
    expect(await screen.findByText(/102\.00/)).toBeInTheDocument(); // $102.00 total
    expect(screen.getByText("Subscriptions")).toBeInTheDocument();
    expect(screen.getByText(/52\.00/)).toBeInTheDocument();
    expect(screen.getByText("Loan payments")).toBeInTheDocument();
    expect(screen.getByText(/30\.00/)).toBeInTheDocument();
    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(screen.getByText(/20\.00/)).toBeInTheDocument();
  });

  it("omits a zero-cost part of the breakdown", async () => {
    mockSummary({
      USD: {
        savings: {
          income_minor: 0, spend_minor: 0, saved_minor: 0, rate_bps: 0,
          prev_saved_minor: 0, prev_rate_bps: 0,
        },
        committed_monthly: {
          total_minor: 5_200, subscriptions_minor: 5_200, loans_minor: 0, planned_minor: 0,
        },
        net_worth_change: {
          now_minor: 0, start_of_month_minor: 0, delta_minor: 0, pct_bps: 0, movers: [],
        },
      },
    });

    renderCard();

    await screen.findByText("Subscriptions");
    expect(screen.queryByText("Loan payments")).not.toBeInTheDocument();
    expect(screen.queryByText("Planned")).not.toBeInTheDocument();
  });

  it("shows a calm empty state when nothing is committed", async () => {
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

    expect(await screen.findByText(/nothing committed yet/i)).toBeInTheDocument();
  });
});
