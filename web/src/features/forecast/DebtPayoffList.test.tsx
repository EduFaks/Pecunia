import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import DebtPayoffList from "./DebtPayoffList";
import type { DebtPayoff } from "./useForecast";

// `useDebtPayoffs` hits `/analytics/debt-payoffs`, and `MoneyText`/`DateText`
// (via `usePreferences`) hit `/auth/me` — both mocked through the same
// `apiFetch` seam `ForecastScreen.test.tsx`/`MonthBreakdown.test.tsx` use,
// rather than a real network round trip (CONVENTIONS §9.10).
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

const PAID_OVER_TIME: DebtPayoff = {
  loan_id: "l1",
  name: "Financiamento do carro",
  remaining_minor: 1_200_000,
  principal_minor: 4_800_000,
  planned_payment_minor: 50_000,
  payment_frequency: "monthly",
  currency: "USD",
  payoff_date: "2027-06-30",
  payments_left: 24,
};

const NEVER_CLEARS: DebtPayoff = {
  loan_id: "l2",
  name: "Cartão renegociado",
  remaining_minor: 9_000_000,
  principal_minor: 10_000_000,
  planned_payment_minor: 10_000,
  payment_frequency: "monthly",
  currency: "USD",
  payoff_date: null,
  payments_left: null,
};

function mockDebtPayoffs(debts: DebtPayoff[] | Error) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path === "/analytics/debt-payoffs") {
      return debts instanceof Error ? Promise.reject(debts) : Promise.resolve(debts);
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("DebtPayoffList", () => {
  it("renders a debt's payoff date, the N× payment caption, and a progress bar", async () => {
    mockDebtPayoffs([PAID_OVER_TIME]);

    renderWithQuery(<DebtPayoffList />);

    expect(await screen.findByText("Financiamento do carro")).toBeInTheDocument();
    expect(screen.getByText("$12,000.00")).toBeInTheDocument(); // remaining
    expect(screen.getByText(/quitado em/i)).toBeInTheDocument();
    expect(screen.getByText("06/30/2027")).toBeInTheDocument();
    expect(screen.getByText(/24×/)).toBeInTheDocument();
    expect(screen.getByText("$500.00")).toBeInTheDocument(); // planned payment

    // True paid fraction: (principal 4,800,000 - remaining 1,200,000) /
    // 4,800,000 = 75% of the debt already paid off — NOT 1/payments_left.
    const bar = screen.getByRole("progressbar", { name: /financiamento do carro/i });
    expect(bar).toHaveAttribute("aria-valuenow", "75");
  });

  it("shows the no-payoff-within-horizon copy when payoff_date is null, but still shows true paid progress", async () => {
    mockDebtPayoffs([NEVER_CLEARS]);

    renderWithQuery(<DebtPayoffList />);

    expect(await screen.findByText("Cartão renegociado")).toBeInTheDocument();
    expect(screen.getByText(/não quita em 24 meses/i)).toBeInTheDocument();
    expect(screen.queryByText(/quitado em/i)).not.toBeInTheDocument();

    // True paid fraction: (principal 10,000,000 - remaining 9,000,000) /
    // 10,000,000 = 10% paid off, even though it won't clear within the
    // horizon at this pace.
    const bar = screen.getByRole("progressbar", { name: /cartão renegociado/i });
    expect(bar).toHaveAttribute("aria-valuenow", "10");
  });

  it("hides the section and shows a one-line note when there are no debts", async () => {
    mockDebtPayoffs([]);

    renderWithQuery(<DebtPayoffList />);

    expect(
      await screen.findByText(/sem dívidas com pagamento programado/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/quitação de dívidas/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows a loading state while the debt list is in flight", () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      return new Promise(() => {}); // never resolves — stays "loading"
    });

    renderWithQuery(<DebtPayoffList />);

    expect(screen.getByText(/carregando/i)).toBeInTheDocument();
  });

  it("shows a calm error state when the debt list fails to load", async () => {
    mockDebtPayoffs(new Error("boom"));

    renderWithQuery(<DebtPayoffList />);

    expect(
      await screen.findByText(/não foi possível carregar suas dívidas/i),
    ).toBeInTheDocument();
  });
});
