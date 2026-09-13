import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import PriceUpdateForm from "./PriceUpdateForm";
import type { HoldingPriceOut } from "./usePortfolios";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const PRICE: HoldingPriceOut = {
  id: "hp1",
  holding_id: "h1",
  unit_price_minor: 46_000,
  as_of: "2026-06-01",
  source: "Broker statement",
  is_demo: false,
  created_at: "2026-06-01T00:00:00Z",
};

function renderForm(onSuccess = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PriceUpdateForm portfolioId="pf1" holdingId="h1" currency="USD" onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

describe("PriceUpdateForm", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("converts the typed unit price to integer minor units for the portfolio's currency", async () => {
    mockApiFetch.mockResolvedValue(PRICE);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "460.00" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Broker statement" } });

    fireEvent.click(screen.getByRole("button", { name: /record price/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/portfolios/pf1/holdings/h1/prices", {
        method: "POST",
        json: { unit_price_minor: 46_000, as_of: "2026-06-01", source: "Broker statement" },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(PRICE));
  });

  it("rejects an invalid amount instead of submitting", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "not-a-number" } });
    fireEvent.click(screen.getByRole("button", { name: /record price/i }));

    expect(await screen.findByText(/valid amount/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
