import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import { qk } from "../../lib/queries";
import PortfolioScreen from "./PortfolioScreen";
import type { PortfolioOut } from "./usePortfolios";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let portfolios: PortfolioOut[];
let nextId: number;

function seedPortfolios(seed: PortfolioOut[]) {
  portfolios = seed.map((p) => ({ ...p }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch
    .mockReset()
    .mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      const method = opts?.method ?? "GET";

      if (path === "/auth/me") {
        return Promise.resolve({ user: null, preferences: null });
      }
      if (path.startsWith("/portfolios?") && method === "GET") {
        return Promise.resolve({ items: portfolios, next_cursor: null });
      }
      if (path === "/portfolios" && method === "POST") {
        const body = opts?.json as { name: string; currency: string; description?: string };
        const created: PortfolioOut = {
          id: `pf${nextId++}`,
          name: body.name,
          currency: body.currency,
          description: body.description ?? null,
          is_demo: false,
          created_at: "2026-09-12T00:00:00Z",
          value_minor: 0,
          holding_count: 0,
        };
        portfolios.push(created);
        return Promise.resolve(created);
      }
      return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
    });
}

function renderScreen() {
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
          initialEntries={["/portfolio"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/portfolio" element={<PortfolioScreen />} />
            <Route path="/portfolio/:id" element={<div>Portfolio detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const BROKERAGE: PortfolioOut = {
  id: "pf1",
  name: "Brokerage",
  currency: "USD",
  description: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  value_minor: 1_250_000,
  holding_count: 3,
};

describe("PortfolioScreen", () => {
  beforeEach(() => {
    seedPortfolios([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no portfolios yet/i)).toBeInTheDocument();
  });

  it("lists portfolios with currency, holding count, and total value", async () => {
    seedPortfolios([BROKERAGE]);
    renderScreen();

    const row = (await screen.findByText("Brokerage")).closest("li")!;
    expect(within(row).getByText(/USD · 3 holdings/)).toBeInTheDocument();
    // value_minor 1_250_000 -> $12,500.00
    expect(within(row).getByText(/12,500\.00/)).toBeInTheDocument();
  });

  it("shows the grand total across portfolios, keeping each currency separate", async () => {
    const CRYPTO: PortfolioOut = {
      id: "pf2",
      name: "Crypto",
      currency: "USD",
      description: null,
      is_demo: false,
      created_at: "2026-01-02T00:00:00Z",
      value_minor: 250_000, // $2,500.00
      holding_count: 1,
    };
    const EURO_FUND: PortfolioOut = {
      id: "pf3",
      name: "Euro fund",
      currency: "EUR",
      description: null,
      is_demo: false,
      created_at: "2026-01-03T00:00:00Z",
      value_minor: 100_000, // €1,000.00
      holding_count: 1,
    };
    seedPortfolios([BROKERAGE, CRYPTO, EURO_FUND]);
    renderScreen();

    await screen.findByText("Brokerage");

    const summaryBlock = screen.getByText("Grand total").parentElement!;
    // 1_250_000 + 250_000 = 1_500_000 minor -> $15,000.00
    expect(within(summaryBlock).getByText(/15,000\.00/)).toBeInTheDocument();
    // The EUR portfolio stays its own separate entry.
    expect(within(summaryBlock).getByText(/1,000\.00/)).toBeInTheDocument();
  });

  it("creates a portfolio with the posted fields and shows it in the list", async () => {
    renderScreen();
    await screen.findByText(/no portfolios yet/i);

    fireEvent.click(
      screen.getAllByRole("button", { name: /new portfolio|add your first portfolio/i })[0],
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Crypto" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });

    fireEvent.click(screen.getByRole("button", { name: /create portfolio/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/portfolios", {
        method: "POST",
        json: { name: "Crypto", currency: "USD" },
      }),
    );
    expect(await screen.findByText("Crypto")).toBeInTheDocument();
  });

  it("navigates to the portfolio detail screen when a row is clicked", async () => {
    seedPortfolios([BROKERAGE]);
    renderScreen();

    fireEvent.click(await screen.findByText("Brokerage"));

    expect(await screen.findByText("Portfolio detail screen")).toBeInTheDocument();
  });
});
