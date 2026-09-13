import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  latest_unit_price_minor: 45_000,
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
        json: { name: "Vanguard S&P 500", quantity: "12.5", symbol: "VOO" },
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
