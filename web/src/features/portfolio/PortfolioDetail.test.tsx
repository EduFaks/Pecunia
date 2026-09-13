import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import PortfolioDetail from "./PortfolioDetail";
import type { HoldingOut, PortfolioOut } from "./usePortfolios";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const PORTFOLIO: PortfolioOut = {
  id: "pf1",
  name: "Brokerage",
  currency: "USD",
  description: "Long-term holdings",
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  // Distinct from every holding figure below so the hero total is
  // unambiguous under getByText.
  value_minor: 1_000_000,
  holding_count: 1,
};

const VOO: HoldingOut = {
  id: "h1",
  portfolio_id: "pf1",
  name: "Vanguard S&P 500",
  symbol: "VOO",
  quantity: "12.50000000",
  latest_unit_price_minor: 45_000, // $450.00
  value_minor: 562_500, // $5,625.00
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
};

function installFakeBackend(options: { portfolio?: PortfolioOut; holdings?: HoldingOut[] } = {}) {
  const portfolio = { ...(options.portfolio ?? PORTFOLIO) };
  const holdings = [...(options.holdings ?? [])];

  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path === "/portfolios/pf1" && method === "GET") {
        return Promise.resolve({ ...portfolio });
      }
      if (path.startsWith("/portfolios/pf1/holdings?") && method === "GET") {
        return Promise.resolve({ items: holdings, next_cursor: null });
      }
      if (path === "/portfolios/pf1/holdings" && method === "POST") {
        const body = opts?.json as { name: string; quantity: string; symbol?: string | null };
        const created: HoldingOut = {
          id: "h-new",
          portfolio_id: "pf1",
          name: body.name,
          symbol: body.symbol ?? null,
          quantity: body.quantity,
          latest_unit_price_minor: null,
          value_minor: 0,
          is_demo: false,
          created_at: "2026-06-01T00:00:00Z",
        };
        holdings.push(created);
        return Promise.resolve(created);
      }
      if (path === "/portfolios/pf1/holdings/h1/prices" && method === "POST") {
        const body = opts?.json as { unit_price_minor: number; as_of: string };
        return Promise.resolve({
          id: "hp-new",
          holding_id: "h1",
          unit_price_minor: body.unit_price_minor,
          as_of: body.as_of,
          source: null,
          is_demo: false,
          created_at: "2026-06-01T00:00:00Z",
        });
      }
      if (path === "/portfolios/pf1/holdings/h1" && method === "DELETE") {
        return Promise.resolve(undefined);
      }
      if (path === "/portfolios/pf1" && method === "DELETE") {
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/portfolio/pf1"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/portfolio" element={<div>Portfolio list screen</div>} />
            <Route path="/portfolio/:id" element={<PortfolioDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("PortfolioDetail", () => {
  beforeEach(() => {
    installFakeBackend({ holdings: [VOO] });
  });

  it("shows the portfolio header (name, currency, total value)", async () => {
    renderDetail();

    const heading = await screen.findByRole("heading", { name: "Brokerage" });
    expect(heading).toBeInTheDocument();
    // Hero total value_minor 1_000_000 -> $10,000.00
    expect(screen.getByText(/10,000\.00/)).toBeInTheDocument();
  });

  it("lists holdings with name/symbol, quantity, latest price, and value", async () => {
    renderDetail();

    const row = (await screen.findByText("Vanguard S&P 500")).closest("tr")!;
    expect(within(row).getByText("VOO")).toBeInTheDocument();
    // quantity "12.50000000" trimmed to "12.5"
    expect(within(row).getByText("12.5")).toBeInTheDocument();
    // latest price $450.00, value $5,625.00
    expect(within(row).getByText(/450\.00/)).toBeInTheDocument();
    expect(within(row).getByText(/5,625\.00/)).toBeInTheDocument();
  });

  it("renders an em dash for a holding with no price recorded yet", async () => {
    installFakeBackend({
      holdings: [{ ...VOO, latest_unit_price_minor: null, value_minor: 0 }],
    });
    renderDetail();

    const row = (await screen.findByText("Vanguard S&P 500")).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("shows a guiding empty state when the portfolio has no holdings", async () => {
    installFakeBackend({ holdings: [] });
    renderDetail();

    expect(await screen.findByText(/no holdings yet/i)).toBeInTheDocument();
  });

  it("records a price for a holding via the Record price panel", async () => {
    renderDetail();
    const row = (await screen.findByText("Vanguard S&P 500")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: /record price/i }));

    const priceForm = screen.getByLabelText("Unit price").closest("form")!;
    fireEvent.change(within(priceForm).getByLabelText("Unit price"), { target: { value: "460" } });
    fireEvent.change(within(priceForm).getByLabelText("Date"), { target: { value: "2026-06-01" } });
    fireEvent.click(within(priceForm).getByRole("button", { name: /record price/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings/h1/prices", {
        method: "POST",
        json: { unit_price_minor: 46_000, as_of: "2026-06-01", source: null },
      }),
    );
  });

  it("adds a holding via the Add holding panel", async () => {
    renderDetail();
    await screen.findByText("Vanguard S&P 500");

    fireEvent.click(screen.getByRole("button", { name: /add holding/i }));

    const holdingForm = screen.getByLabelText("Name").closest("form")!;
    fireEvent.change(within(holdingForm).getByLabelText("Name"), { target: { value: "Apple" } });
    fireEvent.change(within(holdingForm).getByLabelText("Quantity"), { target: { value: "3" } });
    fireEvent.click(within(holdingForm).getByRole("button", { name: /add holding/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings", {
        method: "POST",
        json: { name: "Apple", quantity: "3", symbol: null },
      }),
    );
    expect(await screen.findByText("Apple")).toBeInTheDocument();
  });

  it("confirms before deleting a holding, then deletes on confirm", async () => {
    renderDetail();
    const row = (await screen.findByText("Vanguard S&P 500")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName('Delete "Vanguard S&P 500"?');
    fireEvent.click(screen.getByRole("button", { name: "Delete holding" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings/h1", { method: "DELETE" }),
    );
  });

  it("confirms before deleting the portfolio, then deletes and navigates back", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "Brokerage" });

    // The header's portfolio-level Delete (distinct from a row's Delete). The
    // heading sits in the header's text column; its parent is the flex row
    // that also holds the Edit/Delete button column.
    const header = screen.getByRole("heading", { name: "Brokerage" }).closest("div")!
      .parentElement!;
    fireEvent.click(within(header).getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName('Delete "Brokerage"?');
    fireEvent.click(screen.getByRole("button", { name: "Delete portfolio" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1", { method: "DELETE" }),
    );
    expect(await screen.findByText("Portfolio list screen")).toBeInTheDocument();
  });
});
