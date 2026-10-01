import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import SpendingBreakdownCard, { cashflowDeltaPct, currentMonthRange } from "./SpendingBreakdownCard";

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

const CATEGORIES = [
  { category_id: "c1", name: "Groceries", color: "#22d3ee", spend_minor: 30_000 },
  { category_id: null, name: "Uncategorized", color: null, spend_minor: 10_000 },
];

function mockEndpoints(options: {
  categories?: unknown[] | null;
  cashflow?: Array<{ period_start: string; income_minor: number; spend_minor: number }> | null;
}) {
  mockApiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path.startsWith("/analytics/spending-by-category")) {
      return Promise.resolve(
        options.categories === null || options.categories === undefined
          ? {}
          : { USD: options.categories },
      );
    }
    if (path.startsWith("/analytics/cashflow")) {
      return Promise.resolve(
        options.cashflow === null || options.cashflow === undefined ? {} : { USD: options.cashflow },
      );
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SpendingBreakdownCard />
    </QueryClientProvider>,
  );
}

describe("SpendingBreakdownCard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests spending-by-category scoped to the current calendar month, not the bare 12-month default", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0)); // Oct 15, 2026 (local) — month is 0-indexed
    mockEndpoints({
      categories: CATEGORIES,
      cashflow: [
        { period_start: "2026-08-01", income_minor: 0, spend_minor: 20_000 },
        { period_start: "2026-09-01", income_minor: 0, spend_minor: 40_000 },
      ],
    });

    renderCard();

    await screen.findByRole("img", { name: /spending by category/i });

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/analytics/spending-by-category?from=2026-10-01&to=2026-10-15",
    );
    expect(mockApiFetch).not.toHaveBeenCalledWith("/analytics/spending-by-category");
    // vs-last-month delta still comes from the UNRANGED cashflow query.
    expect(mockApiFetch).toHaveBeenCalledWith("/analytics/cashflow");
  });

  it("renders the category donut and the month total", async () => {
    mockEndpoints({
      categories: CATEGORIES,
      cashflow: [
        { period_start: "2026-08-01", income_minor: 0, spend_minor: 20_000 },
        { period_start: "2026-09-01", income_minor: 0, spend_minor: 40_000 },
      ],
    });

    const { container } = renderCard();

    expect(await screen.findByRole("img", { name: /spending by category/i })).toBeInTheDocument();
    expect(container.querySelectorAll(".recharts-sector")).toHaveLength(2);
    expect(screen.getByText(/400\.00/)).toBeInTheDocument(); // 300 + 100 month total
  });

  it("shows an increase (up) vs last month in red when spend rose", async () => {
    mockEndpoints({
      categories: CATEGORIES,
      cashflow: [
        { period_start: "2026-08-01", income_minor: 0, spend_minor: 10_000 },
        { period_start: "2026-09-01", income_minor: 0, spend_minor: 15_000 },
      ],
    });

    renderCard();

    const delta = await screen.findByText(/50\.0%/);
    expect(delta.textContent).toMatch(/↑/);
    expect(delta).toHaveClass("text-negative");
  });

  it("shows a decrease (down) vs last month in green when spend fell", async () => {
    mockEndpoints({
      categories: CATEGORIES,
      cashflow: [
        { period_start: "2026-08-01", income_minor: 0, spend_minor: 20_000 },
        { period_start: "2026-09-01", income_minor: 0, spend_minor: 10_000 },
      ],
    });

    renderCard();

    const delta = await screen.findByText(/50\.0%/);
    expect(delta.textContent).toMatch(/↓/);
    expect(delta).toHaveClass("text-positive");
  });

  it("guards divide-by-zero: shows a calm label, not NaN/Infinity, when last month's spend was zero", async () => {
    mockEndpoints({
      categories: CATEGORIES,
      cashflow: [
        { period_start: "2026-08-01", income_minor: 0, spend_minor: 0 },
        { period_start: "2026-09-01", income_minor: 0, spend_minor: 5_000 },
      ],
    });

    renderCard();

    await screen.findByRole("img", { name: /spending by category/i });
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
    expect(screen.getByText(/novo|—/)).toBeInTheDocument();
  });

  it("shows a calm empty state when there's no spending this month", async () => {
    mockEndpoints({ categories: [], cashflow: [] });

    renderCard();

    expect(await screen.findByText(/sem gastos neste mês/i)).toBeInTheDocument();
  });

  it("shows an error state when a query fails", async () => {
    mockApiFetch.mockReset().mockImplementation((path: string) => {
      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: PREFERENCES });
      }
      return Promise.reject(new Error("boom"));
    });

    renderCard();

    expect(await screen.findByText(/não foi possível/i)).toBeInTheDocument();
  });
});

describe("cashflowDeltaPct", () => {
  it("computes a signed percent change", () => {
    expect(cashflowDeltaPct(15_000, 10_000)).toBe(50);
    expect(cashflowDeltaPct(10_000, 20_000)).toBe(-50);
  });

  it("returns null (not NaN/Infinity) when the previous period is zero", () => {
    expect(cashflowDeltaPct(5_000, 0)).toBeNull();
    expect(cashflowDeltaPct(0, 0)).toBeNull();
  });
});

describe("currentMonthRange", () => {
  it("spans from the 1st of the month to the given day, using LOCAL date math", () => {
    const range = currentMonthRange(new Date(2026, 9, 15)); // Oct 15, 2026 (local)
    expect(range).toEqual({ from: "2026-10-01", to: "2026-10-15" });
  });

  it("is a single day on the 1st of the month", () => {
    const range = currentMonthRange(new Date(2026, 9, 1));
    expect(range).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  });

  it("rolls the year forward correctly in December/January", () => {
    const range = currentMonthRange(new Date(2026, 11, 31)); // Dec 31, 2026 (local)
    expect(range).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});
