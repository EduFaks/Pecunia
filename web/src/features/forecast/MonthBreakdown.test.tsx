import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { qk } from "../../lib/queries";
import MonthBreakdown from "./MonthBreakdown";
import type { ProjectionPoint } from "./useForecast";

// `MoneyText`/`DateText` read preferences via `usePreferences` ->
// `apiFetch("/auth/me")` (CONVENTIONS §9.10) — mocked rather than a real
// network round trip, same move `BalanceTiles.test.tsx` makes.
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const NOV: ProjectionPoint = {
  date: "2026-11-30",
  optimistic_minor: 260_000,
  realistic_minor: 250_000,
  components: {
    income_minor: 300_000,
    subscriptions_minor: 5_000,
    loans_minor: 20_000,
    card_bills_minor: 15_000,
    variable_minor: 10_000,
  },
  card_bill_labels: [{ label: "Nubank", amount_minor: 15_000 }],
};

const DEC: ProjectionPoint = {
  date: "2026-12-31",
  optimistic_minor: 175_000,
  realistic_minor: 165_000,
  components: {
    income_minor: 300_000,
    subscriptions_minor: 5_000,
    loans_minor: 20_000,
    card_bills_minor: 0,
    variable_minor: 10_000,
  },
  card_bill_labels: [],
};

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

describe("MonthBreakdown", () => {
  it("defaults to the lowest-point month and lists its non-zero components", () => {
    renderWithQuery(
      <MonthBreakdown
        points={[NOV, DEC]}
        lowestPointDate="2026-11-30"
        variableLookbackMonths={6}
        currency="USD"
        locale="en-US"
      />,
    );

    expect(screen.getByText("renda")).toBeInTheDocument();
    expect(screen.getByText("$3,000.00")).toBeInTheDocument(); // income
    expect(screen.getByText("assinaturas e recorrentes")).toBeInTheDocument();
    expect(screen.getByText("$50.00")).toBeInTheDocument(); // subscriptions
    expect(screen.getByText("empréstimos")).toBeInTheDocument();
    expect(screen.getByText("$200.00")).toBeInTheDocument(); // loans
    expect(screen.getByText("fatura Nubank")).toBeInTheDocument();
    expect(screen.getByText("$150.00")).toBeInTheDocument(); // card bill
    expect(screen.getByText("variável médio")).toBeInTheDocument();
    expect(screen.getByText("média de 6 meses")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument(); // variable
    expect(screen.getByText(/saldo/i)).toBeInTheDocument();
    expect(screen.getByText("$2,500.00")).toBeInTheDocument(); // saldo
  });

  it("falls back to the first projected month when the lowest point isn't one of them", () => {
    renderWithQuery(
      <MonthBreakdown
        points={[DEC, NOV]}
        lowestPointDate="2026-10-15"
        variableLookbackMonths={6}
        currency="USD"
        locale="en-US"
      />,
    );

    // DEC is first in `points` and has no card bill — confirms the fallback
    // picked the FIRST projected month, not NOV (whose distinctive "fatura
    // Nubank" row must be absent).
    expect(screen.queryByText("fatura Nubank")).not.toBeInTheDocument();
    expect(screen.getByText("$1,650.00")).toBeInTheDocument(); // DEC's saldo
  });

  it("switches the breakdown when a different month is selected", () => {
    renderWithQuery(
      <MonthBreakdown
        points={[NOV, DEC]}
        lowestPointDate="2026-11-30"
        variableLookbackMonths={6}
        currency="USD"
        locale="en-US"
      />,
    );
    expect(screen.getByText("fatura Nubank")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/mês/i), { target: { value: "2026-12-31" } });

    expect(screen.queryByText("fatura Nubank")).not.toBeInTheDocument();
    expect(screen.getByText("$1,650.00")).toBeInTheDocument(); // DEC's saldo
  });

  it("omits a component row entirely when that month has none of it", () => {
    renderWithQuery(
      <MonthBreakdown
        points={[DEC]}
        lowestPointDate="2026-12-31"
        variableLookbackMonths={6}
        currency="USD"
        locale="en-US"
      />,
    );

    expect(screen.queryByText("fatura")).not.toBeInTheDocument();
    expect(screen.queryByText(/fatura/)).not.toBeInTheDocument();
  });
});
