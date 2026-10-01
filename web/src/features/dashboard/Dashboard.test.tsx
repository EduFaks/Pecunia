import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
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
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<div>Accounts screen</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // Exposed so pull-to-refresh tests can spy on the real client the
  // component reads via `useQueryClient()`, rather than reconstructing one.
  return { ...utils, queryClient };
}

function mockEndpoints(overrides: {
  accounts?: unknown[];
  connections?: unknown[];
  safeToSpend?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  cashflow?: Record<string, unknown[]>;
  spendingByCategory?: Record<string, unknown[]>;
  upcoming?: { due?: unknown[]; over_budget?: unknown[] };
}) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/safe-to-spend")) {
      return Promise.resolve(overrides.safeToSpend ?? {});
    }
    if (path.startsWith("/analytics/summary")) {
      return Promise.resolve(overrides.summary ?? {});
    }
    // Unlike the other analytics endpoints, /analytics/upcoming returns a
    // { due, over_budget } object (not a per-currency map); default both empty.
    if (path.startsWith("/analytics/upcoming")) {
      return Promise.resolve({
        due: overrides.upcoming?.due ?? [],
        over_budget: overrides.upcoming?.over_budget ?? [],
      });
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
    if (path.startsWith("/bank-sync/connections")) {
      return Promise.resolve(overrides.connections ?? []);
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

/** A due date 3 days out from "now" — inside `UpcomingCard`'s 14-day
 * client-side horizon filter (unlike the old `UpcomingWidget`, which trusted
 * the server's unfiltered list, `UpcomingCard` filters against the real
 * clock, so a fixed far-future date like the old test used would be dropped). */
function soonDueDate(): string {
  return new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
}

/** A single non-archived account, enough to get past the welcome empty state
 * so the five dashboard cards mount. */
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

  it("assembles exactly the five new cards, in order, once accounts exist", async () => {
    mockEndpoints({
      accounts: ONE_ACCOUNT,
      safeToSpend: {
        USD: {
          safe_minor: 50000,
          displayed_safe_minor: 50000,
          limited_by: "income",
          expected_income_minor: 100000,
          committed_remaining_minor: 20000,
          spent_mtd_minor: 30000,
          monthly_budget_minor: null,
          days_remaining: 10,
          daily_allowance_minor: 5000,
        },
      },
      summary: {
        USD: {
          savings: {
            income_minor: 100000, spend_minor: 30000, saved_minor: 70000, rate_bps: 7000,
            prev_saved_minor: 0, prev_rate_bps: 0,
          },
          committed_monthly: { total_minor: 20000, subscriptions_minor: 20000, loans_minor: 0, planned_minor: 0 },
          net_worth_change: { now_minor: 0, start_of_month_minor: 0, delta_minor: 0, pct_bps: 0, movers: [] },
        },
      },
      spendingByCategory: {
        USD: [{ category_id: "c1", name: "Groceries", color: "#22d3ee", spend_minor: 30000 }],
      },
      upcoming: {
        due: [
          { kind: "subscription", id: "s1", label: "Spotify", due_on: soonDueDate(), amount_minor: -1099, currency: "USD" },
        ],
      },
      connections: [],
    });

    renderDashboard();

    // Card-identifying headings, in document order: SafeToSpendCard's heading
    // is a dynamic month name (locale-dependent), so it's matched positionally
    // rather than by exact text.
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.length).toBeGreaterThanOrEqual(5);
    expect(headings[0].textContent).not.toBe("");
    expect(headings[1]).toHaveTextContent(/resultado do mês/i);
    expect(headings[2]).toHaveTextContent(/gastei em quê/i);
    expect(headings[3]).toHaveTextContent(/próximos 14 dias/i);
    expect(headings[4]).toHaveTextContent(/contas e cartões/i);

    // SafeToSpendCard's own markers (its heading text is the dynamic month name).
    expect(await screen.findByRole("progressbar", { name: /gasto do mês/i })).toBeInTheDocument();
    expect(await screen.findByText(/spotify/i)).toBeInTheDocument();
  });

  it("does not render the widgets relocated to Insights", async () => {
    mockEndpoints({ accounts: ONE_ACCOUNT });

    renderDashboard();

    await screen.findAllByRole("heading", { level: 2 });

    expect(screen.queryByText(/net worth over time/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/net worth composition/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Savings rate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Committed monthly cost" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Net worth change" })).not.toBeInTheDocument();
    expect(screen.queryByText(/income vs spend/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Goals" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent activity" })).not.toBeInTheDocument();
    // "Accounts" (the old snapshot) must not appear — only "Contas e cartões" should.
    expect(screen.queryByRole("heading", { name: "Accounts" })).not.toBeInTheDocument();
    // "Upcoming" (the old 30-day widget) must not appear — only "Próximos 14 dias" should.
    expect(screen.queryByRole("heading", { name: "Upcoming" })).not.toBeInTheDocument();
  });

  describe("pull-to-refresh", () => {
    it("invalidates analytics, the dashboard accounts read, and bank-sync when pulled past the threshold", async () => {
      mockEndpoints({ accounts: ONE_ACCOUNT, connections: [] });

      const { queryClient } = renderDashboard();
      await screen.findAllByRole("heading", { level: 2 });

      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      const container = screen.getByTestId("dashboard-scroll");

      fireEvent.touchStart(container, { touches: [{ clientY: 0 }] });
      fireEvent.touchMove(container, { touches: [{ clientY: 100 }] });
      fireEvent.touchEnd(container, { changedTouches: [{ clientY: 100 }] });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["analytics"] });
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [...qk.accounts, "dashboard"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.bankSync });
    });

    it("does not refresh when the pull stays under the threshold", async () => {
      mockEndpoints({ accounts: ONE_ACCOUNT, connections: [] });

      const { queryClient } = renderDashboard();
      await screen.findAllByRole("heading", { level: 2 });

      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
      const container = screen.getByTestId("dashboard-scroll");

      fireEvent.touchStart(container, { touches: [{ clientY: 0 }] });
      fireEvent.touchMove(container, { touches: [{ clientY: 20 }] });
      fireEvent.touchEnd(container, { changedTouches: [{ clientY: 20 }] });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });
});
