import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import ForecastScreen from "./ForecastScreen";
import type { DebtPayoff, Projection } from "./useForecast";

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

const DEBT_PAYOFF: DebtPayoff = {
  loan_id: "l1",
  name: "Financiamento do carro",
  remaining_minor: 1_200_000,
  planned_payment_minor: 50_000,
  payment_frequency: "monthly",
  currency: "USD",
  payoff_date: "2027-06-30",
  payments_left: 24,
};

const ZERO_COMPONENTS = {
  income_minor: 300_000,
  subscriptions_minor: 5_000,
  loans_minor: 20_000,
  card_bills_minor: 0,
  variable_minor: 10_000,
};

function buildPoints(count: number): Projection["points"] {
  return Array.from({ length: count }, (_, i) => {
    const monthIndex = 10 + i; // November 2026 (month index 10) onward
    const year = 2026 + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    return {
      date: `${year}-${String(month).padStart(2, "0")}-28`,
      optimistic_minor: 500_000 + i * 1_000,
      realistic_minor: 480_000 + i * 1_000,
      components: ZERO_COMPONENTS,
      card_bill_labels: [],
    };
  });
}

function mockProjection(
  projection: Projection | Record<string, unknown>,
  debtPayoffs: unknown[] = [],
) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/projection")) {
      return Promise.resolve({ USD: projection });
    }
    if (path === "/analytics/debt-payoffs") {
      return Promise.resolve(debtPayoffs);
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ForecastScreen />
    </QueryClientProvider>,
  );
}

describe("ForecastScreen", () => {
  it("shows the positive runway copy when runway_months is null", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: null,
      runway_until: null,
      lowest_point: { value_minor: 480_000, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(
      await screen.findByText(/seu caixa fica no azul pelos próximos 6 meses/i),
    ).toBeInTheDocument();
  });

  it("shows the negative runway copy with the rolled runway_until date", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: 3,
      runway_until: "2027-02-28",
      lowest_point: { value_minor: -50_000, date: "2027-02-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    const heroLine = await screen.findByText(/seu caixa zera em ~3 meses/i);
    // The rolled runway_until date, rendered via DateText in the user's
    // preferred format (MM/DD/YYYY here) — 2027-02-28. Scoped to the hero
    // line itself: this fixture's `lowest_point.date` deliberately coincides
    // with `runway_until`, so the same date ALSO renders in the Task-4
    // lowest-point tile below — a second, equally correct occurrence this
    // test isn't about.
    expect(within(heroLine).getByText(/02\/28\/2027/)).toBeInTheDocument();
  });

  it("pluralizes the runway month correctly for a single month", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: 1,
      runway_until: "2026-12-31",
      lowest_point: { value_minor: -10_000, date: "2026-12-31" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(await screen.findByText(/seu caixa zera em ~1 mês\b/i)).toBeInTheDocument();
  });

  it("defaults to a 6-month horizon and refetches a 12-month one on toggle", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: null,
      runway_until: null,
      lowest_point: { value_minor: 480_000, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();
    await screen.findByText(/seu caixa fica no azul/i);
    expect(mockApiFetch).toHaveBeenCalledWith("/analytics/projection?months=6");

    fireEvent.click(screen.getByRole("button", { name: /12 meses/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/analytics/projection?months=12"),
    );
  });

  it("shows a calm error state when the projection request fails", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      if (path.startsWith("/analytics/projection")) {
        return Promise.reject(new Error("boom"));
      }
      if (path === "/analytics/debt-payoffs") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    renderScreen();

    expect(
      await screen.findByText(/não foi possível carregar sua previsão/i),
    ).toBeInTheDocument();
  });

  it("shows a calm empty state when there is no projection data yet", async () => {
    mockProjection({
      currency: "USD",
      points: [],
      runway_months: null,
      runway_until: null,
      lowest_point: { value_minor: 0, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(
      await screen.findByText(/sem dados suficientes para projetar seu caixa/i),
    ).toBeInTheDocument();
  });

  it("shows the lowest-point tile's value, date, and the biggest card-bill note for that month", async () => {
    const points = buildPoints(6);
    points[0] = {
      ...points[0],
      card_bill_labels: [
        { label: "Nubank", amount_minor: 10_000 },
        { label: "BTG", amount_minor: 25_000 },
      ],
    };
    mockProjection({
      currency: "USD",
      points,
      // Deliberately a DIFFERENT month than `lowest_point.date` so the runway
      // hero's own rolled date doesn't coincidentally duplicate the one this
      // test checks on the lowest-point tile.
      runway_months: 1,
      runway_until: "2026-12-28",
      lowest_point: { value_minor: -50_000, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(await screen.findByText(/menor saldo/i)).toBeInTheDocument();
    expect(screen.getByText("-$500.00")).toBeInTheDocument();
    expect(screen.getByText("11/28/2026")).toBeInTheDocument();
    // The BIGGEST label (BTG, $250) is named, not the smaller Nubank one.
    expect(screen.getByText(/após fatura BTG/i)).toBeInTheDocument();
    expect(screen.queryByText(/após fatura Nubank/i)).not.toBeInTheDocument();
  });

  it("shows no card-bill note on the lowest-point tile when that month has no bill", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: 1,
      runway_until: "2026-11-28",
      lowest_point: { value_minor: -50_000, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    await screen.findByText(/menor saldo/i);
    expect(screen.queryByText(/após fatura/i)).not.toBeInTheDocument();
  });

  it("shows the recovery tile's date and signed value when the dip recovers", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: 1,
      runway_until: "2026-11-28",
      lowest_point: { value_minor: -50_000, date: "2026-11-28" },
      recovery: { date: "2027-01-28", value_minor: 20_000 },
      variable_lookback_months: 6,
    });

    renderScreen();

    const headline = await screen.findByText(/de volta ao azul/i);
    // Scoped to the recovery tile itself: `MonthBreakdown`'s own "renda" row
    // below is a second, unrelated "+" amount on the same screen. The "+"
    // glyph is a direct text-node sibling of the `MoneyText` span (same
    // idiom `SafeToSpendCard` already uses for its signed rows), so it's
    // its own match rather than part of "$200.00"'s own node text.
    const tile = headline.parentElement as HTMLElement;
    expect(within(tile).getByText("01/28/2027")).toBeInTheDocument();
    expect(within(tile).getByText("+")).toBeInTheDocument();
    expect(within(tile).getByText("$200.00")).toBeInTheDocument();
  });

  it("shows a reassuring line instead of the recovery tile when the balance never goes negative", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: null,
      runway_until: null,
      lowest_point: { value_minor: 480_000, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(await screen.findByText(/caixa positivo o período todo/i)).toBeInTheDocument();
    expect(screen.queryByText(/de volta ao azul/i)).not.toBeInTheDocument();
  });

  it("shows a muted no-recovery line when the dip never climbs back within the horizon", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: 3,
      runway_until: "2027-01-28",
      lowest_point: { value_minor: -50_000, date: "2027-01-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(
      await screen.findByText(/sem recuperação prevista no período/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/de volta ao azul/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/caixa positivo o período todo/i)).not.toBeInTheDocument();
  });

  it("renders the month breakdown for the lowest-point month by default", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: 1,
      runway_until: "2026-11-28",
      lowest_point: { value_minor: -50_000, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(await screen.findByText(/o que compõe/i)).toBeInTheDocument();
    expect(screen.getByText("renda")).toBeInTheDocument();
    expect(screen.getByText("variável médio")).toBeInTheDocument();
    expect(screen.getByText("média de 6 meses")).toBeInTheDocument();
  });

  it("renders the debt-payoff list (Task 5) alongside the projection", async () => {
    mockProjection(
      {
        currency: "USD",
        points: buildPoints(6),
        runway_months: null,
        runway_until: null,
        lowest_point: { value_minor: 480_000, date: "2026-11-28" },
        recovery: null,
        variable_lookback_months: 6,
      },
      [DEBT_PAYOFF],
    );

    renderScreen();

    expect(await screen.findByText(/quitação de dívidas/i)).toBeInTheDocument();
    expect(await screen.findByText("Financiamento do carro")).toBeInTheDocument();
  });

  it("shows the empty-debts note instead of the debt section's card when there are none", async () => {
    mockProjection({
      currency: "USD",
      points: buildPoints(6),
      runway_months: null,
      runway_until: null,
      lowest_point: { value_minor: 480_000, date: "2026-11-28" },
      recovery: null,
      variable_lookback_months: 6,
    });

    renderScreen();

    expect(
      await screen.findByText(/sem dívidas com pagamento programado/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/quitação de dívidas/i)).not.toBeInTheDocument();
  });

  it("renders the debt-payoff list even while the cash projection is still loading", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      if (path === "/analytics/debt-payoffs") {
        return Promise.resolve([DEBT_PAYOFF]);
      }
      if (path.startsWith("/analytics/projection")) {
        return new Promise(() => {}); // never resolves — projection stays "loading"
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    renderScreen();

    // The projection's own card is still showing its loading copy...
    expect(await screen.findByText(/carregando/i)).toBeInTheDocument();
    // ...but the independently-fetched debt list is not held hostage by it.
    expect(await screen.findByText("Financiamento do carro")).toBeInTheDocument();
  });
});
