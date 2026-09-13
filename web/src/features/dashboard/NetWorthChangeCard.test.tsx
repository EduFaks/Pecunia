import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import NetWorthChangeCard from "./NetWorthChangeCard";

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
      <NetWorthChangeCard />
    </QueryClientProvider>,
  );
}

describe("NetWorthChangeCard", () => {
  it("shows the delta, percentage, and top movers", async () => {
    mockSummary({
      USD: {
        savings: {
          income_minor: 0, spend_minor: 0, saved_minor: 0, rate_bps: 0,
          prev_saved_minor: 0, prev_rate_bps: 0,
        },
        committed_monthly: { total_minor: 0, subscriptions_minor: 0, loans_minor: 0, planned_minor: 0 },
        net_worth_change: {
          now_minor: 105_000, start_of_month_minor: 70_000, delta_minor: 35_000, pct_bps: 5_000,
          movers: [
            { label: "Cash", delta_minor: 20_000 },
            { label: "Debts", delta_minor: 10_000 },
            { label: "Assets", delta_minor: 5_000 },
          ],
        },
      },
    });

    const { container } = renderCard();

    expect(await screen.findByRole("heading", { name: /net worth change/i })).toBeInTheDocument();
    expect(await screen.findByText(/350\.00/)).toBeInTheDocument(); // $350.00 delta
    expect(screen.getByText(/\+50\.0%/)).toBeInTheDocument();
    expect(container.querySelector(".lucide-arrow-up-right")).not.toBeNull();
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("Debts")).toBeInTheDocument();
    expect(screen.getByText("Assets")).toBeInTheDocument();
  });

  it("shows a down arrow when net worth fell", async () => {
    mockSummary({
      USD: {
        savings: {
          income_minor: 0, spend_minor: 0, saved_minor: 0, rate_bps: 0,
          prev_saved_minor: 0, prev_rate_bps: 0,
        },
        committed_monthly: { total_minor: 0, subscriptions_minor: 0, loans_minor: 0, planned_minor: 0 },
        net_worth_change: {
          now_minor: 50_000, start_of_month_minor: 70_000, delta_minor: -20_000, pct_bps: -2_857,
          movers: [{ label: "Cash", delta_minor: -20_000 }],
        },
      },
    });

    const { container } = renderCard();

    await screen.findByText(/-28\.6%|−28\.6%/);
    expect(container.querySelector(".lucide-arrow-down-right")).not.toBeNull();
  });

  it("shows a calm empty state when the base currency is absent from the response", async () => {
    mockSummary({});

    renderCard();

    expect(await screen.findByText(/no net-worth history yet/i)).toBeInTheDocument();
  });
});
