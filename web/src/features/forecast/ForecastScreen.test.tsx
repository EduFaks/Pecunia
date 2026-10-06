import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import ForecastScreen from "./ForecastScreen";
import type { Projection } from "./useForecast";

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

function mockProjection(projection: Projection | Record<string, unknown>) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/projection")) {
      return Promise.resolve({ USD: projection });
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

    expect(await screen.findByText(/seu caixa zera em ~3 meses/i)).toBeInTheDocument();
    // The rolled runway_until date, rendered via DateText in the user's
    // preferred format (MM/DD/YYYY here) — 2027-02-28.
    expect(screen.getByText(/02\/28\/2027/)).toBeInTheDocument();
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
});
