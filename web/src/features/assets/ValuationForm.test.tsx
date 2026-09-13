import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import ValuationForm from "./ValuationForm";
import type { AssetValuationOut } from "./useAssets";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const VALUATION: AssetValuationOut = {
  id: "v1",
  asset_id: "as1",
  value_minor: 4_600_000,
  as_of: "2026-06-01",
  source: "Appraisal",
  is_demo: false,
  created_at: "2026-06-01T00:00:00Z",
};

function renderForm(onSuccess = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ValuationForm assetId="as1" currency="USD" onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return { onSuccess };
}

describe("ValuationForm", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("converts the typed decimal amount to integer minor units for the asset's currency", async () => {
    mockApiFetch.mockResolvedValue(VALUATION);
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "46000.00" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Appraisal" } });

    fireEvent.click(screen.getByRole("button", { name: /add valuation/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/assets/as1/valuations", {
        method: "POST",
        json: { value_minor: 4_600_000, as_of: "2026-06-01", source: "Appraisal" },
      }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(VALUATION));
  });

  it("omits source when left blank", async () => {
    mockApiFetch.mockResolvedValue(VALUATION);
    renderForm();

    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /add valuation/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/assets/as1/valuations",
        expect.objectContaining({ json: expect.objectContaining({ source: null }) }),
      ),
    );
  });

  it("rejects an invalid amount instead of submitting", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "not-a-number" } });
    fireEvent.click(screen.getByRole("button", { name: /add valuation/i }));

    expect(await screen.findByText(/valid amount/i)).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
