import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import Dashboard from "./Dashboard";

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

function renderDashboard() {
  // `retry: false` so an intentionally-erroring accounts fetch fails fast
  // instead of TanStack Query's default backoff.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<div>Accounts screen</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockEndpoints(overrides: {
  accounts?: unknown[];
  assets?: unknown[];
  portfolios?: unknown[];
  loans?: unknown[];
  activity?: unknown[];
  transactions?: unknown[];
  netWorth?: Record<string, unknown[]>;
  cashflow?: Record<string, unknown[]>;
  spendingByCategory?: Record<string, unknown[]>;
  upcoming?: { due?: unknown[]; over_budget?: unknown[] };
}) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    // Unlike the other analytics endpoints, /analytics/upcoming returns a
    // { due, over_budget } object (not a per-currency map); default both empty.
    if (path.startsWith("/analytics/upcoming")) {
      return Promise.resolve({
        due: overrides.upcoming?.due ?? [],
        over_budget: overrides.upcoming?.over_budget ?? [],
      });
    }
    // Analytics endpoints return a per-currency map ({currency: [...]}),
    // defaulting to an empty map (no currency has data) unless overridden.
    if (path.startsWith("/analytics/net-worth")) {
      return Promise.resolve(overrides.netWorth ?? {});
    }
    if (path.startsWith("/analytics/cashflow")) {
      return Promise.resolve(overrides.cashflow ?? {});
    }
    if (path.startsWith("/analytics/spending-by-category")) {
      return Promise.resolve(overrides.spendingByCategory ?? {});
    }
    if (path.startsWith("/accounts")) {
      return Promise.resolve({ items: overrides.accounts ?? [], next_cursor: null });
    }
    if (path.startsWith("/assets")) {
      return Promise.resolve({ items: overrides.assets ?? [], next_cursor: null });
    }
    if (path.startsWith("/portfolios")) {
      return Promise.resolve({ items: overrides.portfolios ?? [], next_cursor: null });
    }
    if (path.startsWith("/loans")) {
      return Promise.resolve({ items: overrides.loans ?? [], next_cursor: null });
    }
    if (path.startsWith("/activity")) {
      return Promise.resolve({ items: overrides.activity ?? [], next_cursor: null });
    }
    if (path.startsWith("/transactions")) {
      return Promise.resolve({ items: overrides.transactions ?? [], next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

/** A single non-archived account, enough to get past the welcome empty state
 * so the analytics graphs mount. */
const ONE_ACCOUNT = [
  { id: "a1", name: "Checking", type: "checking", currency: "USD", balance_minor: 500000, archived_at: null },
];

describe("Dashboard", () => {
  beforeEach(() => {
    mockEndpoints({});
  });

  it("shows a welcoming empty state guiding to add the first account on a fresh instance", async () => {
    mockEndpoints({ accounts: [] });

    renderDashboard();

    expect(await screen.findByRole("heading", { name: /welcome/i })).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: /add your first account/i });
    fireEvent.click(cta);

    expect(await screen.findByText("Accounts screen")).toBeInTheDocument();
  });

  it("renders the hero net worth, accounts snapshot, and recent activity from real data", async () => {
    mockEndpoints({
      accounts: [
        {
          id: "a1",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balance_minor: 500000,
          archived_at: null,
        },
      ],
      assets: [
        { id: "s1", name: "Model 3", currency: "USD", current_value_minor: 3000000 },
      ],
      activity: [
        {
          id: 1,
          occurred_at: "2026-09-10T00:00:00.000Z",
          template_key: "activity.account.created",
          params: { name: "Checking", type: "checking" },
        },
      ],
    });

    renderDashboard();

    // Net worth = 500000 + 3000000 = 3500000 minor units -> $35,000.00
    expect(await screen.findByText(/35,000\.00/)).toBeInTheDocument();
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.getByText('Account "Checking" created (checking).')).toBeInTheDocument();
  });

  it("includes portfolio value in the hero net worth", async () => {
    mockEndpoints({
      accounts: [
        {
          id: "a1",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balance_minor: 500000,
          archived_at: null,
        },
      ],
      assets: [{ id: "s1", name: "Model 3", currency: "USD", current_value_minor: 3000000 }],
      portfolios: [
        {
          id: "pf1",
          name: "Brokerage",
          currency: "USD",
          description: null,
          is_demo: false,
          created_at: "2026-01-01T00:00:00Z",
          value_minor: 2000000,
          holding_count: 2,
        },
      ],
    });

    renderDashboard();

    // 500000 + 3000000 + 2000000 = 5500000 minor units -> $55,000.00
    expect(await screen.findByText(/55,000\.00/)).toBeInTheDocument();
  });

  it("drops the hero net worth by a borrowed loan's remaining balance", async () => {
    mockEndpoints({
      accounts: [
        {
          id: "a1",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balance_minor: 5_000_000,
          archived_at: null,
        },
      ],
      loans: [
        {
          id: "l1",
          name: "Car loan",
          direction: "borrowed",
          principal_minor: 2_500_000,
          currency: "USD",
          interest_rate_bps: null,
          planned_payment_minor: null,
          payment_frequency: null,
          next_due: null,
          opened_on: null,
          description: null,
          is_demo: false,
          created_at: "2026-01-01T00:00:00Z",
          paid_total_minor: 300_000,
          remaining_minor: 1_200_000,
        },
      ],
    });

    renderDashboard();

    // 5,000,000 − 1,200,000 (borrowed remaining) = 3,800,000 → $38,000.00
    expect(await screen.findByText(/38,000\.00/)).toBeInTheDocument();
  });

  it("shows the primary account's recent-balance trend as the AccountsSnapshot sparkline", async () => {
    mockEndpoints({
      accounts: [
        {
          id: "a1",
          name: "Checking",
          type: "checking",
          currency: "USD",
          balance_minor: 1500,
          archived_at: null,
        },
      ],
      transactions: [
        { occurred_on: "2026-01-02", amount_minor: 500 },
        { occurred_on: "2026-01-01", amount_minor: 1000 },
      ],
    });

    renderDashboard();

    // The per-account balance history now lives ONLY as the inline sparkline
    // in AccountsSnapshot (role="img") — the standalone per-account line chart
    // was removed. The net-worth/cashflow/category series are empty here, so
    // those cards show empty states (not charts), leaving exactly one img.
    const charts = await screen.findAllByRole("img");
    expect(charts).toHaveLength(1);
  });

  it("charts net worth over time as a neutral Recharts area from the net-worth series", async () => {
    mockEndpoints({
      accounts: ONE_ACCOUNT,
      netWorth: {
        USD: [
          { date: "2026-01-01", net_worth_minor: 100000 },
          { date: "2026-02-01", net_worth_minor: 120000 },
          { date: "2026-03-01", net_worth_minor: 150000 },
        ],
      },
    });

    const { container } = renderDashboard();

    expect(await screen.findByRole("heading", { name: /net worth over time/i })).toBeInTheDocument();
    // The chart is a labeled figure (role=img) whose aria-label summarizes the
    // trend; the Recharts area paints inside it.
    await screen.findByRole("img", { name: /net worth: trending up/i });
    expect(container.querySelector(".recharts-area")).not.toBeNull();
    expect(container.querySelector("svg.recharts-surface")).not.toBeNull();
  });

  it("charts income vs spend as two Recharts bar series from the cashflow series", async () => {
    mockEndpoints({
      accounts: ONE_ACCOUNT,
      cashflow: {
        USD: [
          { period_start: "2026-01-01", income_minor: 400000, spend_minor: 100000 },
          { period_start: "2026-02-01", income_minor: 200000, spend_minor: 300000 },
        ],
      },
    });

    const { container } = renderDashboard();

    expect(await screen.findByRole("heading", { name: /income vs spend/i })).toBeInTheDocument();
    await screen.findByRole("img", { name: /income vs spend/i });
    // One Recharts bar series each for income and spend.
    expect(container.querySelectorAll(".recharts-bar")).toHaveLength(2);
    // The legend names both series — identity is never color-alone.
    expect(await screen.findByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Spend")).toBeInTheDocument();
  });

  it("charts a category donut (Recharts pie) from the spending-by-category breakdown", async () => {
    mockEndpoints({
      accounts: ONE_ACCOUNT,
      spendingByCategory: {
        USD: [
          { category_id: "c1", name: "Groceries", color: "#22d3ee", spend_minor: 30000 },
          { category_id: null, name: "Uncategorized", color: null, spend_minor: 10000 },
        ],
      },
    });

    const { container } = renderDashboard();

    expect(await screen.findByRole("heading", { name: /spending by category/i })).toBeInTheDocument();
    await screen.findByRole("img", { name: /spending by category/i });
    // One pie sector per positive category.
    expect(container.querySelectorAll(".recharts-sector")).toHaveLength(2);
    // The legend lists each category with its amount, sorted desc.
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    expect(screen.getByText(/300\.00/)).toBeInTheDocument();
  });

  it("charts the base currency when the analytics response holds several currencies", async () => {
    mockEndpoints({
      accounts: ONE_ACCOUNT,
      netWorth: {
        // Base currency (USD) trends up; EUR trends down — the chart must
        // read the base currency's series, not EUR's.
        USD: [
          { date: "2026-01-01", net_worth_minor: 100000 },
          { date: "2026-02-01", net_worth_minor: 150000 },
        ],
        EUR: [
          { date: "2026-01-01", net_worth_minor: 90000 },
          { date: "2026-02-01", net_worth_minor: 20000 },
        ],
      },
    });

    renderDashboard();

    const chart = await screen.findByRole("img", { name: /net worth: trending up/i });
    const label = chart.getAttribute("aria-label") ?? "";
    expect(label).toContain("1,500.00"); // USD's last point ($1,500.00)
    expect(label).not.toContain("down");
  });

  it("shows tasteful empty states for the analytics graphs when their series are empty", async () => {
    mockEndpoints({ accounts: ONE_ACCOUNT }); // analytics all default to {}

    renderDashboard();

    expect(await screen.findByText(/no net-worth history yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no income or spending recorded yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no spending to break down yet/i)).toBeInTheDocument();
  });

  it("mounts the Upcoming widget, rendering a due item from /analytics/upcoming", async () => {
    mockEndpoints({
      accounts: ONE_ACCOUNT,
      upcoming: {
        due: [
          {
            kind: "subscription",
            id: "s1",
            label: "Spotify",
            due_on: "2999-01-01",
            amount_minor: -1099,
            currency: "USD",
          },
        ],
        over_budget: [],
      },
    });

    renderDashboard();

    expect(await screen.findByRole("heading", { name: /upcoming/i })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /spotify/i })).toHaveAttribute(
      "href",
      "/subscriptions",
    );
  });

  it("shows an error callout when the accounts fetch fails", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      if (path.startsWith("/accounts")) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ items: [], next_cursor: null });
    });

    renderDashboard();

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load/i);
  });
});
