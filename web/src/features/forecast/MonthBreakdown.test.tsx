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
  // Deliberately NOT equal to this month's own delta (income 3000 −
  // subscriptions 50 − loans 200 − card bill 150 = 2500): `realistic_minor`
  // is the RUNNING balance (today's starting cash plus every month's own
  // delta so far), so it only coincides with this month's own delta when
  // the starting balance happens to be zero. Keeping it distinct here
  // proves "Variação do mês" and "Saldo projetado" are two independently
  // rendered figures, not the same number shown twice.
  realistic_minor: 325_000,
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

    // The rows above sum EXACTLY to "Variação do mês" — the month's own net
    // change (3000 − 50 − 200 − 150 − 100 = 2500) — not to "Saldo
    // projetado", which is a separate, independently-shown running balance
    // (NOV's fixture `realistic_minor` is deliberately a different number).
    expect(screen.getByText("Variação do mês")).toBeInTheDocument();
    expect(screen.getByText("$2,500.00")).toBeInTheDocument(); // variação
    expect(screen.getByText("Saldo projetado")).toBeInTheDocument();
    expect(screen.getByText("$3,250.00")).toBeInTheDocument(); // saldo
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
    // DEC's rows (3000 − 50 − 200 − 100) sum to a variação of 2650 — NOT
    // DEC's own saldo of 1650 (the running balance, a different, separately
    // shown figure). This is the exact gap the "→ saldo" wording used to
    // paper over.
    expect(screen.getByText("$2,650.00")).toBeInTheDocument(); // DEC's variação
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
    expect(screen.getByText("$2,500.00")).toBeInTheDocument(); // NOV's variação
    expect(screen.getByText("$3,250.00")).toBeInTheDocument(); // NOV's saldo

    fireEvent.change(screen.getByLabelText(/mês/i), { target: { value: "2026-12-31" } });

    // Switching months updates BOTH total lines, and NOV's old figures are
    // gone — not just the row list.
    expect(screen.queryByText("fatura Nubank")).not.toBeInTheDocument();
    expect(screen.getByText("$2,650.00")).toBeInTheDocument(); // DEC's variação
    expect(screen.getByText("$1,650.00")).toBeInTheDocument(); // DEC's saldo
    expect(screen.queryByText("$2,500.00")).not.toBeInTheDocument(); // NOV's variação is gone
    expect(screen.queryByText("$3,250.00")).not.toBeInTheDocument(); // NOV's saldo is gone
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
