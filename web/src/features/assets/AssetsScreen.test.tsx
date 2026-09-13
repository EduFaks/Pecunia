import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { ToastProvider } from "../../components/ui/Toast";
import AssetsScreen from "./AssetsScreen";
import type { AssetOut } from "./useAssets";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

let assets: AssetOut[];
let nextId: number;

function seedAssets(seed: AssetOut[]) {
  assets = seed.map((asset) => ({ ...asset }));
  nextId = seed.length + 1;
}

function installFakeBackend() {
  mockApiFetch.mockReset().mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
    const method = opts?.method ?? "GET";

    if (path.startsWith("/assets?") && method === "GET") {
      return Promise.resolve({ items: assets, next_cursor: null });
    }
    if (path === "/assets" && method === "POST") {
      const body = opts?.json as { name: string; type: string; currency: string; acquired_on?: string };
      const created: AssetOut = {
        id: `as${nextId++}`,
        name: body.name,
        type: body.type as AssetOut["type"],
        currency: body.currency,
        acquired_on: body.acquired_on ?? null,
        current_value_minor: null,
        is_demo: false,
        created_at: "2026-09-11T00:00:00Z",
        updated_at: "2026-09-11T00:00:00Z",
      };
      assets.push(created);
      return Promise.resolve(created);
    }
    return Promise.reject(new Error(`unexpected call: ${method} ${path}`));
  });
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={["/assets"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/assets" element={<AssetsScreen />} />
            <Route path="/assets/:id" element={<div>Asset detail screen</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const MUSTANG: AssetOut = {
  id: "as1",
  name: "1967 Mustang",
  type: "vehicle",
  currency: "USD",
  acquired_on: "2020-01-01",
  current_value_minor: 4_500_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("AssetsScreen", () => {
  beforeEach(() => {
    seedAssets([]);
    installFakeBackend();
  });

  it("shows a guiding empty state on a fresh workspace", async () => {
    renderScreen();
    expect(await screen.findByText(/no assets yet/i)).toBeInTheDocument();
  });

  it("lists assets with name, type, and current value", async () => {
    seedAssets([MUSTANG]);
    renderScreen();

    expect(await screen.findByText("1967 Mustang")).toBeInTheDocument();
    expect(screen.getByText("Vehicle")).toBeInTheDocument();
    expect(screen.getByText(/45,000\.00/)).toBeInTheDocument();
  });

  it("creates an asset with the posted fields and shows it in the list", async () => {
    renderScreen();
    await screen.findByText(/no assets yet/i);

    fireEvent.click(screen.getAllByRole("button", { name: /new asset|add your first asset/i })[0]);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rolex Submariner" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "watch" } });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });

    fireEvent.click(screen.getByRole("button", { name: /create asset/i }));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/assets", {
        method: "POST",
        json: { name: "Rolex Submariner", type: "watch", currency: "USD" },
      }),
    );

    expect(await screen.findByText("Rolex Submariner")).toBeInTheDocument();
  });

  it("navigates to the asset detail screen when a row is clicked", async () => {
    seedAssets([MUSTANG]);
    renderScreen();

    fireEvent.click(await screen.findByText("1967 Mustang"));

    expect(await screen.findByText("Asset detail screen")).toBeInTheDocument();
  });
});
