import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import HoldingForm from "./HoldingForm";
import type { HoldingOut } from "./usePortfolios";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const HOLDING: HoldingOut = {
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

function renderForm(props: Partial<Parameters<typeof HoldingForm>[0]> = {}) {
  const onSuccess = props.onSuccess ?? vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <HoldingForm portfolioId="pf1" onSuccess={onSuccess} {...props} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

describe("HoldingForm", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a holding, sending the quantity as a string", async () => {
    mockApiFetch.mockResolvedValue(HOLDING);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Vanguard S&P 500" } });
    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "VOO" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "12.5" } });

    fireEvent.click(screen.getByRole("button", { name: /add holding/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings", {
        method: "POST",
        json: { name: "Vanguard S&P 500", quantity: "12.5", symbol: "VOO", coingecko_id: null },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(HOLDING));
  });

  it("sends a null symbol when the symbol is left blank", async () => {
    mockApiFetch.mockResolvedValue(HOLDING);
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cash reserve" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /add holding/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/portfolios/pf1/holdings",
        expect.objectContaining({ json: expect.objectContaining({ symbol: null }) }),
      ),
    );
  });

  it("rejects a non-positive or invalid quantity instead of submitting", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bad" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /add holding/i }));

    expect(await screen.findByText(/greater than zero/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("picking a coin sends its coingecko_id", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiFetch.mockImplementation((path: string) => {
      if (typeof path === "string" && path.startsWith("/portfolios/coins")) {
        return Promise.resolve([{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }]);
      }
      return Promise.resolve({ ...HOLDING, coingecko_id: "bitcoin" });
    });
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bitcoin" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0.5" } });

    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "bit" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    fireEvent.click(await screen.findByRole("option", { name: /^Bitcoin btc$/i }));

    fireEvent.click(screen.getByRole("button", { name: /add holding/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/portfolios/pf1/holdings",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({ coingecko_id: "bitcoin" }),
        }),
      ),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it("edits an existing holding via PATCH", async () => {
    mockApiFetch.mockResolvedValue({ ...HOLDING, quantity: "20.00000000" });
    renderForm({ holding: HOLDING });

    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/portfolios/pf1/holdings/h1",
        expect.objectContaining({ method: "PATCH", json: expect.objectContaining({ quantity: "20" }) }),
      ),
    );
  });
});
