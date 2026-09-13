import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import BalanceTiles from "./BalanceTiles";
import type { AccountSummary, AssetSummary } from "./balances";

// `MoneyText` reads preferences via `usePreferences` -> `apiFetch("/auth/me")`
// (CONVENTIONS §9.10) — mocked here rather than a real network round trip.
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.me, {
    user: null,
    preferences: {
      base_currency: "USD",
      locale: "en-US",
      date_format: "MM/DD/YYYY",
      number_format: "1,234.56",
      timezone: "UTC",
      first_day_of_week: "monday",
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "a1",
    name: "Checking",
    type: "checking",
    currency: "USD",
    balance_minor: 100000,
    archived_at: null,
    ...overrides,
  };
}

describe("BalanceTiles", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: null });
  });

  it("renders the base currency's net worth as the hero figure", () => {
    const accounts = [account({ currency: "USD", balance_minor: 250000 })];
    const assets: AssetSummary[] = [
      { id: "s1", name: "Model 3", currency: "USD", current_value_minor: 5000000 },
    ];

    renderWithQuery(<BalanceTiles accounts={accounts} assets={assets} baseCurrency="USD" />);

    // 250000 + 5000000 = 5250000 minor units -> $52,500.00
    expect(screen.getByText(/52,500\.00/)).toBeInTheDocument();
  });

  it("includes portfolio value in the base-currency hero net worth", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    const assets: AssetSummary[] = [
      { id: "s1", name: "Model 3", currency: "USD", current_value_minor: 5000000 },
    ];
    const portfolios = [{ currency: "USD", value_minor: 2000000 }];

    renderWithQuery(
      <BalanceTiles accounts={accounts} assets={assets} portfolios={portfolios} baseCurrency="USD" />,
    );

    // 100000 + 5000000 + 2000000 = 7100000 minor units -> $71,000.00
    expect(screen.getByText(/71,000\.00/)).toBeInTheDocument();
    // Portfolio value surfaces as an "Investments" breakdown part ($20,000.00).
    expect(screen.getByText("Investments")).toBeInTheDocument();
    expect(screen.getByText(/20,000\.00/)).toBeInTheDocument();
  });

  it("renders a secondary tile for each non-base currency with its own balance and net worth", () => {
    const accounts = [
      account({ id: "a1", currency: "USD", balance_minor: 100000 }),
      account({ id: "a2", currency: "EUR", balance_minor: 40000 }),
    ];
    const assets: AssetSummary[] = [
      { id: "s1", name: "Villa", currency: "EUR", current_value_minor: 10000 },
    ];

    renderWithQuery(<BalanceTiles accounts={accounts} assets={assets} baseCurrency="USD" />);

    expect(screen.getByText("EUR")).toBeInTheDocument();
    // Balance 40000 -> €400.00, net worth 50000 -> €500.00
    expect(screen.getByText(/400\.00/)).toBeInTheDocument();
    expect(screen.getByText(/500\.00/)).toBeInTheDocument();
  });

  it("renders no secondary tiles when every account/asset shares the base currency", () => {
    const accounts = [account({ currency: "USD" })];
    renderWithQuery(<BalanceTiles accounts={accounts} assets={[]} baseCurrency="USD" />);

    expect(screen.queryByText("EUR")).not.toBeInTheDocument();
  });

  it("flags a negative base-currency net worth coral, but never colors a positive one emerald", () => {
    const accounts = [account({ currency: "USD", balance_minor: -500000 })];
    const { container } = renderWithQuery(
      <BalanceTiles accounts={accounts} assets={[]} baseCurrency="USD" />,
    );

    const hero = screen.getByText(/5,000\.00/);
    expect(hero).toHaveClass("text-negative");
    expect(container.querySelectorAll(".text-positive")).toHaveLength(0);
  });

  it("renders the hero net worth in the display font", () => {
    const accounts = [account({ currency: "USD", balance_minor: 100000 })];
    renderWithQuery(<BalanceTiles accounts={accounts} assets={[]} baseCurrency="USD" />);

    expect(screen.getByText(/1,000\.00/)).toHaveClass("font-display");
  });
});
