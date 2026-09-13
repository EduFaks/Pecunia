import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useAddHolding,
  useCoinSearch,
  useCreatePortfolio,
  useDeleteHolding,
  useDeletePortfolio,
  useHoldings,
  usePortfolio,
  usePortfolios,
  useRecordPrice,
  useRefreshPrices,
  useUpdateHolding,
  useUpdatePortfolio,
} from "./usePortfolios";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper, queryClient };
}

const PORTFOLIO = {
  id: "pf1",
  name: "Brokerage",
  currency: "USD",
  description: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  value_minor: 12_500_00,
  holding_count: 2,
};

const HOLDING = {
  id: "h1",
  portfolio_id: "pf1",
  name: "Vanguard S&P 500",
  symbol: "VOO",
  quantity: "12.50000000",
  coingecko_id: null,
  latest_unit_price_minor: 45_000,
  latest_price_source: null,
  latest_price_as_of: null,
  value_minor: 562_500,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
};

/** Every portfolio/holding/price mutation must refresh the portfolios prefix
 * AND `["analytics"]` for net worth — but NOT `qk.accounts`: a portfolio change
 * doesn't move account balances, so that over-broad invalidation was trimmed
 * (the net-worth tile still updates via the portfolios prefix). */
function expectNetWorthInvalidations(invalidateSpy: MockInstance<QueryClient["invalidateQueries"]>) {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["portfolios"] });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["analytics"] });
  expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["accounts"] });
  // A portfolio/holding/price change can move a portfolio- or net-worth-
  // sourced goal's progress, so goals re-read too (L3).
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
}

describe("usePortfolios", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the portfolio list", async () => {
    mockApiFetch.mockResolvedValue({ items: [PORTFOLIO], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => usePortfolios(), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toEqual([PORTFOLIO]));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios?limit=200");
  });
});

describe("usePortfolio", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches a single portfolio by id", async () => {
    mockApiFetch.mockResolvedValue(PORTFOLIO);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => usePortfolio("pf1"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(PORTFOLIO));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1");
  });

  it("stays disabled (no fetch) while id is undefined", () => {
    const { wrapper } = makeWrapper();
    renderHook(() => usePortfolio(undefined), { wrapper });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("useHoldings", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches a portfolio's holdings", async () => {
    mockApiFetch.mockResolvedValue({ items: [HOLDING], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useHoldings("pf1"), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toEqual([HOLDING]));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings?limit=200");
  });

  it("stays disabled while portfolioId is undefined", () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useHoldings(undefined), { wrapper });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("useCreatePortfolio", () => {
  it("posts the create payload and invalidates portfolios + net-worth keys", async () => {
    mockApiFetch.mockReset().mockResolvedValue(PORTFOLIO);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreatePortfolio(), { wrapper });
    result.current.mutate({ name: "Brokerage", currency: "USD" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios", {
      method: "POST",
      json: { name: "Brokerage", currency: "USD" },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useUpdatePortfolio", () => {
  it("patches the portfolio and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...PORTFOLIO, name: "Renamed" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdatePortfolio("pf1"), { wrapper });
    result.current.mutate({ name: "Renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1", {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useDeletePortfolio", () => {
  it("deletes the portfolio and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeletePortfolio(), { wrapper });
    result.current.mutate("pf1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1", { method: "DELETE" });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useAddHolding", () => {
  it("posts the holding (quantity as a string) and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue(HOLDING);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useAddHolding("pf1"), { wrapper });
    result.current.mutate({ name: "Vanguard S&P 500", quantity: "12.5", symbol: "VOO" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings", {
      method: "POST",
      json: { name: "Vanguard S&P 500", quantity: "12.5", symbol: "VOO" },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useUpdateHolding", () => {
  it("patches the holding and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue(HOLDING);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateHolding("pf1", "h1"), { wrapper });
    result.current.mutate({ quantity: "20" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings/h1", {
      method: "PATCH",
      json: { quantity: "20" },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useDeleteHolding", () => {
  it("deletes the holding and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteHolding("pf1"), { wrapper });
    result.current.mutate("h1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings/h1", { method: "DELETE" });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useRecordPrice", () => {
  it("posts the price and invalidates portfolios + net-worth keys", async () => {
    const PRICE = {
      id: "hp1",
      holding_id: "h1",
      unit_price_minor: 46_000,
      as_of: "2026-06-01",
      source: null,
      is_demo: false,
      created_at: "2026-06-01T00:00:00Z",
    };
    mockApiFetch.mockReset().mockResolvedValue(PRICE);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRecordPrice("pf1", "h1"), { wrapper });
    result.current.mutate({ unit_price_minor: 46_000, as_of: "2026-06-01", source: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings/h1/prices", {
      method: "POST",
      json: { unit_price_minor: 46_000, as_of: "2026-06-01", source: null },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useRefreshPrices", () => {
  it("posts the refresh and invalidates portfolios + net-worth keys", async () => {
    const RESULT = { updated: 2, skipped: 1, errors: [] };
    mockApiFetch.mockReset().mockResolvedValue(RESULT);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRefreshPrices(), { wrapper });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/refresh-prices", { method: "POST" });
    expect(result.current.data).toEqual(RESULT);
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useCoinSearch", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the coin-search proxy with the query string", async () => {
    const COINS = [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }];
    mockApiFetch.mockResolvedValue(COINS);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useCoinSearch("bit"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(COINS));
    expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/coins?q=bit");
  });

  it("does not fetch while disabled", () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useCoinSearch("bit", false), { wrapper });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
