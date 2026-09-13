import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import AssetDetail from "./AssetDetail";
import type { AssetOut, AssetValuationOut } from "./useAssets";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

const ASSET: AssetOut = {
  id: "as1",
  name: "1967 Mustang",
  type: "vehicle",
  currency: "USD",
  acquired_on: "2020-01-01",
  // Deliberately distinct from every valuation fixture's `value_minor`
  // below (40k/50k/30k/45k) — the header, the chart's axis labels, and the
  // valuation-history rows all format amounts the same way, so a shared
  // figure between them would make `getByText` ambiguous.
  current_value_minor: 5_555_500,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** `GET /assets/{id}/valuations` returns newest-first (as_of desc) — same
 * order the real API keyset-paginates in. */
const RISING_VALUATIONS: AssetValuationOut[] = [
  {
    id: "v2",
    asset_id: "as1",
    value_minor: 5_000_000,
    as_of: "2026-03-01",
    source: "Appraisal",
    is_demo: false,
    created_at: "2026-03-01T00:00:00Z",
  },
  {
    id: "v1",
    asset_id: "as1",
    value_minor: 4_000_000,
    as_of: "2026-01-01",
    source: "Purchase price",
    is_demo: false,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const DECLINING_VALUATIONS: AssetValuationOut[] = [
  {
    id: "v2",
    asset_id: "as1",
    value_minor: 3_000_000,
    as_of: "2026-03-01",
    source: "Appraisal",
    is_demo: false,
    created_at: "2026-03-01T00:00:00Z",
  },
  {
    id: "v1",
    asset_id: "as1",
    value_minor: 4_500_000,
    as_of: "2026-01-01",
    source: "Purchase price",
    is_demo: false,
    created_at: "2026-01-01T00:00:00Z",
  },
];

function installFakeBackend(
  options: { asset?: AssetOut; valuations?: AssetValuationOut[] } = {},
) {
  const asset = { ...(options.asset ?? ASSET) };
  const valuations = [...(options.valuations ?? [])];

  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path === "/assets/as1" && method === "GET") {
      return Promise.resolve({ ...asset });
    }
    if (path.startsWith("/assets/as1/valuations?") && method === "GET") {
      return Promise.resolve({ items: valuations, next_cursor: null });
    }
    if (path === "/assets/as1/valuations" && method === "POST") {
      const body = opts?.json as { value_minor: number; as_of: string; source?: string | null };
      const created: AssetValuationOut = {
        id: "v-new",
        asset_id: "as1",
        value_minor: body.value_minor,
        as_of: body.as_of,
        source: body.source ?? null,
        is_demo: false,
        created_at: "2026-06-01T00:00:00Z",
      };
      valuations.unshift(created);
      asset.current_value_minor = body.value_minor;
      return Promise.resolve(created);
    }
    if (path === "/assets/as1" && method === "DELETE") {
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/assets/as1"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/assets" element={<div>Assets list screen</div>} />
            <Route path="/assets/:id" element={<AssetDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("AssetDetail", () => {
  beforeEach(() => {
    installFakeBackend();
  });

  it("shows the asset's header (name, type, current value)", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    renderDetail();

    const heading = await screen.findByRole("heading", { name: "1967 Mustang" });
    const header = heading.closest("div")!;
    expect(within(header).getByText("Vehicle")).toBeInTheDocument();
    expect(within(header).getByText(/55,555\.00/)).toBeInTheDocument();
  });

  it("renders the valuation-history chart in emerald when the series rises", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    const { container } = renderDetail();

    await screen.findByRole("heading", { name: "1967 Mustang" });
    // A Recharts area whose series color is driven off the `--color-valueMinor`
    // config var the ChartContainer publishes — emerald (`--pc-positive`) for a
    // rising trend, the value-movement semantic §9.1 reserves emerald/coral for.
    const chart = await waitFor(() => {
      const el = container.querySelector("[data-chart]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(container.querySelector(".recharts-area")).not.toBeNull();
    expect(chart.style.getPropertyValue("--color-valueMinor")).toBe("var(--pc-positive)");
  });

  it("renders the valuation-history chart in coral when the series declines", async () => {
    installFakeBackend({ valuations: DECLINING_VALUATIONS });
    const { container } = renderDetail();

    await screen.findByRole("heading", { name: "1967 Mustang" });
    const chart = await waitFor(() => {
      const el = container.querySelector("[data-chart]") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(container.querySelector(".recharts-area")).not.toBeNull();
    expect(chart.style.getPropertyValue("--color-valueMinor")).toBe("var(--pc-negative)");
  });

  it("shows a guiding empty state when the asset has no valuations yet", async () => {
    renderDetail();
    expect(await screen.findByText(/no valuations yet/i)).toBeInTheDocument();
  });

  it("lists the valuation history (as_of, value, source)", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    renderDetail();

    await screen.findByRole("heading", { name: "1967 Mustang" });
    const list = await screen.findByRole("list");
    expect(within(list).getByText("Appraisal")).toBeInTheDocument();
    expect(within(list).getByText("Purchase price")).toBeInTheDocument();
    expect(within(list).getByText(/40,000\.00/)).toBeInTheDocument();
  });

  it("adding a valuation updates the chart and the header's current value", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    renderDetail();
    const heading = await screen.findByRole("heading", { name: "1967 Mustang" });
    const header = heading.closest("div")!;

    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "60000" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: /add valuation/i }));

    await waitFor(() => expect(within(header).getByText(/60,000\.00/)).toBeInTheDocument());
  });

  it("edits the asset via the inline edit panel", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    renderDetail();
    await screen.findByRole("heading", { name: "1967 Mustang" });

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed Mustang" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/assets/as1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
  });

  it("clicking Delete opens a confirmation instead of deleting immediately", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    renderDetail();
    await screen.findByRole("heading", { name: "1967 Mustang" });

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName('Delete "1967 Mustang"?');
    expect(mockApiFetch).not.toHaveBeenCalledWith("/assets/as1", { method: "DELETE" });
  });

  it("cancelling the confirmation does not delete the asset", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    renderDetail();
    await screen.findByRole("heading", { name: "1967 Mustang" });

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith("/assets/as1", { method: "DELETE" });
  });

  it("confirming the deletion deletes the asset and navigates back to the assets list", async () => {
    installFakeBackend({ valuations: RISING_VALUATIONS });
    renderDetail();
    await screen.findByRole("heading", { name: "1967 Mustang" });

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete asset" }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/assets/as1", { method: "DELETE" }),
    );
    expect(await screen.findByText("Assets list screen")).toBeInTheDocument();
  });
});
