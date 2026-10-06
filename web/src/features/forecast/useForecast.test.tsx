import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { projectionPath, selectProjection, useDebtPayoffs, useProjection } from "./useForecast";
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

const USD_PROJECTION: Projection = {
  currency: "USD",
  points: [
    {
      date: "2026-11-30",
      optimistic_minor: 500_000,
      realistic_minor: 480_000,
      components: {
        income_minor: 300_000,
        subscriptions_minor: 5_000,
        loans_minor: 20_000,
        card_bills_minor: 15_000,
        variable_minor: 10_000,
      },
      card_bill_labels: [{ label: "Nubank", amount_minor: 15_000 }],
    },
    {
      date: "2026-12-31",
      optimistic_minor: 520_000,
      realistic_minor: 460_000,
      components: {
        income_minor: 300_000,
        subscriptions_minor: 5_000,
        loans_minor: 20_000,
        card_bills_minor: 0,
        variable_minor: 10_000,
      },
      card_bill_labels: [],
    },
  ],
  runway_months: null,
  runway_until: null,
  lowest_point: { value_minor: 460_000, date: "2026-12-31" },
  recovery: null,
  variable_lookback_months: 6,
};

const EUR_PROJECTION: Projection = { ...USD_PROJECTION, currency: "EUR" };

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper, queryClient };
}

describe("projectionPath", () => {
  it("appends the required months horizon", () => {
    expect(projectionPath(6)).toBe("/analytics/projection?months=6");
    expect(projectionPath(12)).toBe("/analytics/projection?months=12");
  });
});

describe("selectProjection", () => {
  it("picks the requested currency's projection out of the per-currency response", () => {
    expect(selectProjection({ USD: USD_PROJECTION, EUR: EUR_PROJECTION }, "USD")).toEqual(
      USD_PROJECTION,
    );
    expect(selectProjection({ USD: USD_PROJECTION, EUR: EUR_PROJECTION }, "EUR")).toEqual(
      EUR_PROJECTION,
    );
  });

  it("returns undefined for a currency absent from the response", () => {
    expect(selectProjection({ USD: USD_PROJECTION }, "GBP")).toBeUndefined();
  });

  it("returns undefined when the response is undefined (still loading)", () => {
    expect(selectProjection(undefined, "USD")).toBeUndefined();
  });
});

describe("useProjection", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the horizon's projection and selects the base currency's entry", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      if (path === "/analytics/projection?months=6") {
        return Promise.resolve({ USD: USD_PROJECTION, EUR: EUR_PROJECTION });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useProjection(6), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/analytics/projection?months=6");
    expect(result.current.data).toEqual(USD_PROJECTION);
  });

  it("keys a 12-month horizon as its own cache slot, distinct from 6", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      if (path === "/analytics/projection?months=12") {
        return Promise.resolve({ USD: USD_PROJECTION });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const { wrapper, queryClient } = makeWrapper();

    renderHook(() => useProjection(12), { wrapper });

    await waitFor(() =>
      expect(queryClient.getQueryData(["analytics", "projection", { months: 12 }])).toEqual({
        USD: USD_PROJECTION,
      }),
    );
  });

  it("returns undefined data for a currency absent from the response", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      if (path === "/analytics/projection?months=6") {
        return Promise.resolve({ EUR: EUR_PROJECTION });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useProjection(6), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe("useDebtPayoffs", () => {
  const PAYOFF: DebtPayoff = {
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

  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the flat debt-payoff list under its own bare key", async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === "/analytics/debt-payoffs") {
        return Promise.resolve([PAYOFF]);
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const { wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(() => useDebtPayoffs(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/analytics/debt-payoffs");
    expect(result.current.data).toEqual([PAYOFF]);
    expect(queryClient.getQueryData(["analytics", "debt-payoffs"])).toEqual([PAYOFF]);
  });
});
