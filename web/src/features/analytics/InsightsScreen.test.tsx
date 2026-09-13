import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { AuthContextValue } from "../../lib/auth";
import AppShell from "../../components/layout/AppShell";
import InsightsScreen from "./InsightsScreen";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

// AppShell (used only by the nav-routing test) reads auth and mounts DemoChip;
// stub both so the shell renders without an auth/query round trip of its own.
vi.mock("../../lib/auth", () => ({ useAuth: vi.fn() }));
vi.mock("../../components/layout/DemoChip", () => ({ default: () => <span>demo-chip-stub</span> }));

const PREFERENCES = {
  base_currency: "USD",
  locale: "en-US",
  date_format: "MM/DD/YYYY",
  number_format: "1,234.56",
  timezone: "UTC",
  first_day_of_week: "monday",
};

interface Overrides {
  spendingByContact?: Record<string, unknown[]>;
  spendingByCategory?: Record<string, unknown[]>;
  netWorthComposition?: Record<string, unknown[]>;
  projects?: unknown[];
}

function mockEndpoints(overrides: Overrides = {}) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/net-worth-composition")) {
      return Promise.resolve(overrides.netWorthComposition ?? {});
    }
    if (path.startsWith("/analytics/spending-by-contact")) {
      return Promise.resolve(overrides.spendingByContact ?? {});
    }
    if (path.startsWith("/analytics/spending-by-category")) {
      return Promise.resolve(overrides.spendingByCategory ?? {});
    }
    if (path.startsWith("/projects")) {
      return Promise.resolve({ items: overrides.projects ?? [], next_cursor: null });
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <InsightsScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Pulls the `from` query param out of every recorded call to a given
 * analytics endpoint — how the period-selector test proves the window moved. */
function fromParamsFor(endpoint: string): string[] {
  return mockApiFetch.mock.calls
    .map(([path]) => path as string)
    .filter((path) => path.startsWith(endpoint))
    .map((path) => new URL(path, "http://x").searchParams.get("from") ?? "");
}

function authState(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: { id: "u1", email: "ada@example.com", name: "Ada", display_name: null },
    status: "authed",
    login: vi.fn(),
    adoptSession: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    ...overrides,
  };
}

describe("InsightsScreen", () => {
  beforeEach(() => {
    mockEndpoints();
    vi.mocked(useAuth).mockReturnValue(authState());
  });

  it("renders a spending-by-contact breakdown in the base currency, ignoring other currencies", async () => {
    mockEndpoints({
      spendingByContact: {
        USD: [
          { contact_id: "p1", name: "Landlord", spend_minor: 50000 },
          { contact_id: null, name: "No contact", spend_minor: 10000 },
        ],
        EUR: [{ contact_id: "p2", name: "Euro Shop", spend_minor: 99999 }],
      },
    });

    const { container } = renderScreen();

    // The ranked figures live in the companion legend list; the Recharts bars
    // are the vibrant magnitude read beside it (a labeled role="img" figure).
    const list = await screen.findByRole("list", { name: /spending by contact/i });
    const rows = within(list).getAllByRole("listitem");
    // Ranked by spend: Landlord (50000) first, the null "No contact" bucket after.
    expect(rows[0]).toHaveTextContent("Landlord");
    expect(rows[0]).toHaveTextContent("500.00");
    expect(rows[1]).toHaveTextContent("No contact");
    // The EUR-only contact must not leak into the USD (base-currency) view.
    expect(screen.queryByText("Euro Shop")).not.toBeInTheDocument();
    // The horizontal bar chart renders one Recharts bar series for the ranking.
    expect(await screen.findByRole("img", { name: /spending by contact/i })).toBeInTheDocument();
    expect(container.querySelectorAll(".recharts-bar").length).toBeGreaterThan(0);
  });

  it("charts net-worth composition as stacked areas in the base currency, ignoring other currencies", async () => {
    mockEndpoints({
      netWorthComposition: {
        USD: [
          {
            period_start: "2026-01-01",
            cash_minor: 100000,
            assets_minor: 50000,
            investments_minor: 20000,
            debts_minor: -30000,
          },
          {
            period_start: "2026-02-01",
            cash_minor: 110000,
            assets_minor: 55000,
            investments_minor: 25000,
            debts_minor: -20000,
          },
        ],
        // A EUR series that must never leak into the USD (base-currency) view.
        EUR: [
          {
            period_start: "2026-02-01",
            cash_minor: 9999900,
            assets_minor: 0,
            investments_minor: 0,
            debts_minor: 0,
          },
        ],
      },
    });

    const { container } = renderScreen();

    // The stacked-area figure carries a base-currency summary (latest net worth
    // 110000 + 55000 + 25000 − 20000 = 170000 → $1,700.00).
    const figure = await screen.findByRole("img", { name: /net worth composition/i });
    expect(figure).toHaveAccessibleName(/\$1,700\.00/);
    // Four bands: cash, assets, investments, debts.
    expect(container.querySelectorAll(".recharts-area")).toHaveLength(4);
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("Debts")).toBeInTheDocument();
    // The EUR-only figure must not appear in the USD view.
    expect(screen.queryByText(/99,999/)).not.toBeInTheDocument();
  });

  it("flows the selected period into the net-worth composition query", async () => {
    mockEndpoints({
      netWorthComposition: {
        USD: [
          {
            period_start: "2026-02-01",
            cash_minor: 110000,
            assets_minor: 55000,
            investments_minor: 25000,
            debts_minor: -20000,
          },
        ],
      },
    });

    renderScreen();

    await screen.findByRole("img", { name: /net worth composition/i });
    const initialFrom = fromParamsFor("/analytics/net-worth-composition").at(-1) ?? "";
    expect(initialFrom).not.toBe(""); // the default 12-month window sends a `from`

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    // A new fetch fires for the narrower window: same `to`, a later `from`.
    await waitFor(() => {
      const froms = fromParamsFor("/analytics/net-worth-composition");
      expect(froms.length).toBeGreaterThan(1);
      expect(froms.at(-1)! > initialFrom).toBe(true);
    });
  });

  it("narrows the queried window when the period selector switches to 3 months", async () => {
    mockEndpoints({
      spendingByContact: { USD: [{ contact_id: "p1", name: "Landlord", spend_minor: 50000 }] },
    });

    renderScreen();

    await screen.findByRole("list", { name: /spending by contact/i });
    const initialFrom = fromParamsFor("/analytics/spending-by-contact").at(-1) ?? "";
    expect(initialFrom).not.toBe(""); // the default 12-month window sends a `from`

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    // A new fetch fires for the narrower window: same `to`, a later `from`.
    await waitFor(() => {
      const froms = fromParamsFor("/analytics/spending-by-contact");
      expect(froms.length).toBeGreaterThan(1);
      expect(froms.at(-1)! > initialFrom).toBe(true);
    });
  });

  it("widens the queried window when the period selector switches to 24 months", async () => {
    mockEndpoints({
      spendingByContact: { USD: [{ contact_id: "p1", name: "Landlord", spend_minor: 50000 }] },
    });

    renderScreen();

    await screen.findByRole("list", { name: /spending by contact/i });
    const initialFrom = fromParamsFor("/analytics/spending-by-contact").at(-1) ?? "";
    expect(initialFrom).not.toBe(""); // the default 12-month window sends a `from`

    fireEvent.click(screen.getByRole("button", { name: "24 months" }));

    // A new fetch fires for the wider window: an earlier `from`.
    await waitFor(() => {
      const froms = fromParamsFor("/analytics/spending-by-contact");
      expect(froms.length).toBeGreaterThan(1);
      expect(froms.at(-1)! < initialFrom).toBe(true);
    });
  });

  it("switches every breakdown to all=true (no from) when All time is selected", async () => {
    mockEndpoints({
      spendingByContact: { USD: [{ contact_id: "p1", name: "Landlord", spend_minor: 50000 }] },
    });

    renderScreen();
    await screen.findByRole("list", { name: /spending by contact/i });

    fireEvent.click(screen.getByRole("button", { name: "All time" }));

    await waitFor(() => {
      for (const endpoint of [
        "/analytics/net-worth-composition",
        "/analytics/spending-by-contact",
        "/analytics/spending-by-category",
      ]) {
        const latest = mockApiFetch.mock.calls
          .map(([path]) => path as string)
          .filter((path) => path.startsWith(endpoint))
          .at(-1)!;
        const params = new URL(latest, "http://x").searchParams;
        expect(params.get("all")).toBe("true");
        expect(params.get("from")).toBeNull();
      }
    });
  });

  it("renders a project-spend summary from the projects list, ranked by realized actual", async () => {
    mockEndpoints({
      projects: [
        {
          id: "pr1",
          name: "Kitchen",
          currency: "USD",
          actual_minor: 30000,
          planned_minor: 50000,
          target_amount_minor: null,
        },
        {
          id: "pr2",
          name: "Trip",
          currency: "USD",
          actual_minor: 80000,
          planned_minor: 0,
          target_amount_minor: 100000,
        },
        // An account in another currency must not join the base-currency ranking.
        {
          id: "pr3",
          name: "Euro Reno",
          currency: "EUR",
          actual_minor: 999999,
          planned_minor: 0,
          target_amount_minor: null,
        },
      ],
    });

    renderScreen();

    const list = await screen.findByRole("list", { name: /project spend/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Trip"); // 80000 outranks Kitchen's 30000
    expect(rows[1]).toHaveTextContent("Kitchen");
    expect(screen.queryByText("Euro Reno")).not.toBeInTheDocument();
    // The realized-vs-plan caption renders (target preferred over planned).
    expect(screen.getByText(/of \$1,000\.00 target/)).toBeInTheDocument();
    expect(screen.getByText(/of \$500\.00 planned/)).toBeInTheDocument();
    // The ranking also renders as a Recharts horizontal bar figure.
    expect(await screen.findByRole("img", { name: /project spend/i })).toBeInTheDocument();
  });

  it("charts spending by category as a Recharts donut with a name+amount legend", async () => {
    mockEndpoints({
      spendingByCategory: {
        USD: [
          { category_id: "c1", name: "Groceries", color: "#22d3ee", spend_minor: 30000 },
          { category_id: null, name: "Uncategorized", color: null, spend_minor: 10000 },
        ],
      },
    });

    const { container } = renderScreen();

    await screen.findByRole("img", { name: /spending by category/i });
    // One pie sector per positive category.
    expect(container.querySelectorAll(".recharts-sector")).toHaveLength(2);
    // The legend lists each category with its amount.
    const legend = screen.getByRole("list", { name: /spending by category/i });
    expect(within(legend).getByText("Groceries")).toBeInTheDocument();
    expect(within(legend).getByText("Uncategorized")).toBeInTheDocument();
    expect(within(legend).getByText(/300\.00/)).toBeInTheDocument();
  });

  it("shows calm empty states, not fake charts, when every source is empty", async () => {
    mockEndpoints(); // all analytics {} and projects []

    renderScreen();

    expect(await screen.findByText(/no contact spending in this period yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no spending to break down yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no project spending recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("routes to the Insights screen from the sidebar nav entry", async () => {
    mockEndpoints({
      spendingByContact: { USD: [{ contact_id: "p1", name: "Landlord", spend_minor: 50000 }] },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={["/"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<div>Dashboard screen</div>} />
              <Route path="insights" element={<InsightsScreen />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Insights" }));

    expect(await screen.findByRole("heading", { name: "Insights" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: /spending by contact/i })).toBeInTheDocument();
  });
});
