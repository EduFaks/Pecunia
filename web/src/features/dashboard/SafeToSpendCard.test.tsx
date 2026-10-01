import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import SafeToSpendCard, { safeToSpendPercent } from "./SafeToSpendCard";

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

// income(500.00) - committed(50.00) - spent(220.00) = safe(230.00); daily
// allowance = 230.00 / 10 days remaining = 23.00 — an internally consistent
// fixture (mirrors `SafeToSpendService`'s real arithmetic) even though the
// component itself never recomputes any of this, only displays it.
const BASE_ENTRY = {
  safe_minor: 23_000,
  displayed_safe_minor: 23_000,
  limited_by: "income" as const,
  expected_income_minor: 50_000,
  committed_remaining_minor: 5_000,
  spent_mtd_minor: 22_000,
  monthly_budget_minor: null,
  days_remaining: 10,
  daily_allowance_minor: 2_300,
};

function mockSafeToSpend(entry: Record<string, unknown> | null, putResponse?: unknown) {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === "/auth/me") {
      return Promise.resolve({ user: null, preferences: PREFERENCES });
    }
    if (path === "/analytics/safe-to-spend") {
      return Promise.resolve(entry === null ? {} : { USD: entry });
    }
    if (path === "/settings/monthly-budget" && opts?.method === "PUT") {
      return Promise.resolve(putResponse ?? { monthly_budget_minor: null });
    }
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SafeToSpendCard />
    </QueryClientProvider>,
  );
}

describe("SafeToSpendCard", () => {
  it("renders the hero safe-to-spend figure and daily allowance", async () => {
    mockSafeToSpend(BASE_ENTRY);

    renderCard();

    expect(await screen.findByText(/livre pra gastar/i)).toBeInTheDocument();
    expect(screen.getByText(/230\.00/)).toBeInTheDocument(); // $230.00 safe to spend
    expect(screen.getByText(/\/dia/)).toBeInTheDocument();
    expect(screen.getByText(/23\.00/)).toBeInTheDocument(); // $23.00/day
  });

  it("shows the limited-by-budget note only when limited_by is budget", async () => {
    mockSafeToSpend({
      ...BASE_ENTRY,
      displayed_safe_minor: 3_000,
      limited_by: "budget",
      monthly_budget_minor: 25_000,
    });

    renderCard();

    expect(await screen.findByText(/limitado pelo orçamento/i)).toBeInTheDocument();
  });

  it("omits the limited-by-budget note when limited_by is income", async () => {
    mockSafeToSpend(BASE_ENTRY);

    renderCard();

    await screen.findByText(/livre pra gastar/i);
    expect(screen.queryByText(/limitado pelo orçamento/i)).not.toBeInTheDocument();
  });

  it("shows the one-line renda / fixos a vir / gasto breakdown", async () => {
    mockSafeToSpend(BASE_ENTRY);

    renderCard();

    expect(await screen.findByText(/renda/i)).toBeInTheDocument();
    expect(screen.getByText(/fixos a vir/i)).toBeInTheDocument();
    expect(screen.getByText(/gasto/i)).toBeInTheDocument();
    expect(screen.getByText(/500\.00/)).toBeInTheDocument(); // income
    expect(screen.getByText(/50\.00/)).toBeInTheDocument(); // committed remaining
    expect(screen.getByText(/220\.00/)).toBeInTheDocument(); // spent MTD
  });

  it("shows the negative tone and overspend note when displayed_safe_minor is negative", async () => {
    mockSafeToSpend({
      ...BASE_ENTRY,
      displayed_safe_minor: -5_000,
      limited_by: "budget",
      monthly_budget_minor: 17_000,
    });

    renderCard();

    expect(await screen.findByText(/você passou do limite/i)).toBeInTheDocument();
  });

  it("shows a calm empty state when the base currency is absent from the response", async () => {
    mockSafeToSpend(null);

    renderCard();

    expect(await screen.findByText(/sem dados/i)).toBeInTheDocument();
  });

  it("sets a monthly budget via the inline editor", async () => {
    mockSafeToSpend(BASE_ENTRY, { monthly_budget_minor: 25_000 });

    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: /definir orçamento/i }));
    fireEvent.change(screen.getByLabelText(/orçamento mensal/i), { target: { value: "250.00" } });
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/settings/monthly-budget", {
        method: "PUT",
        json: { monthly_budget_minor: 25_000 },
      }),
    );
  });

  it("sends null when the budget input is submitted empty (clears the budget)", async () => {
    mockSafeToSpend({ ...BASE_ENTRY, monthly_budget_minor: 25_000 }, { monthly_budget_minor: null });

    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: /definir orçamento/i }));
    fireEvent.change(screen.getByLabelText(/orçamento mensal/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /salvar/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/settings/monthly-budget", {
        method: "PUT",
        json: { monthly_budget_minor: null },
      }),
    );
  });

  it("closes the editor without saving on cancel", async () => {
    mockSafeToSpend(BASE_ENTRY);

    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: /definir orçamento/i }));
    expect(screen.getByLabelText(/orçamento mensal/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));

    expect(screen.queryByLabelText(/orçamento mensal/i)).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      "/settings/monthly-budget",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("safeToSpendPercent", () => {
  it("computes a clamped percent of spend against the ceiling", () => {
    expect(safeToSpendPercent(5_000, 5_000)).toBe(50);
  });

  it("clamps at 100 when the safe amount is negative (ceiling collapses to spent)", () => {
    expect(safeToSpendPercent(5_000, -2_000)).toBe(100);
  });

  it("returns 0 when nothing has been spent and nothing is safe (no division by zero)", () => {
    expect(safeToSpendPercent(0, 0)).toBe(0);
  });

  it("never exceeds 100 even when spend somehow exceeds the ceiling", () => {
    expect(safeToSpendPercent(9_000, 1_000)).toBe(90);
  });
});
