import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import AccountsSnapshot from "./AccountsSnapshot";
import type { AccountSummary } from "./balances";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function renderWithProviders(ui: ReactElement) {
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
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

describe("AccountsSnapshot", () => {
  beforeEach(() => {
    mockApiFetch.mockReset().mockResolvedValue({ user: null, preferences: null });
  });

  it("renders each account's name, humanized type, and balance", () => {
    const accounts = [
      account({ id: "a1", name: "Checking", type: "checking", balance_minor: 150000 }),
      account({ id: "a2", name: "Rainy Day", type: "credit_card", balance_minor: -2000 }),
    ];

    renderWithProviders(<AccountsSnapshot accounts={accounts} />);

    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.getByText("checking")).toBeInTheDocument();
    expect(screen.getByText(/1,500\.00/)).toBeInTheDocument();

    expect(screen.getByText("Rainy Day")).toBeInTheDocument();
    expect(screen.getByText("credit card")).toBeInTheDocument();
    expect(screen.getByText(/20\.00/)).toBeInTheDocument();
  });

  it("links to the full accounts screen", () => {
    renderWithProviders(<AccountsSnapshot accounts={[account()]} />);

    expect(screen.getByRole("link", { name: /view all/i })).toHaveAttribute("href", "/accounts");
  });

  it("renders a Recharts sparkline next to the primary account when a series is given", () => {
    const accounts = [account({ id: "a1" })];
    const { container } = renderWithProviders(
      <AccountsSnapshot
        accounts={accounts}
        primaryAccountId="a1"
        primarySeries={[
          { date: "2026-01-01", valueMinor: 100 },
          { date: "2026-01-02", valueMinor: 200 },
        ]}
      />,
    );

    // A labeled figure (role=img) with the Recharts line painted inside it.
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(container.querySelector("svg.recharts-surface")).not.toBeNull();
    expect(container.querySelector(".recharts-line")).not.toBeNull();
  });

  it("omits the sparkline when the primary series has fewer than two points", () => {
    const accounts = [account({ id: "a1" })];
    const { container } = renderWithProviders(
      <AccountsSnapshot
        accounts={accounts}
        primaryAccountId="a1"
        primarySeries={[{ date: "2026-01-01", valueMinor: 100 }]}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg.recharts-surface")).toBeNull();
  });
});
