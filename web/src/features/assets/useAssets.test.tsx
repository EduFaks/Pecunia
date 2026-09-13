import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useAddValuation,
  useAsset,
  useCreateAsset,
  useDeleteAsset,
  useUpdateAsset,
} from "./useAssets";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
const mockApiFetch = vi.mocked(apiFetch);

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper, queryClient };
}

const ASSET = {
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

describe("useAsset", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches a single asset by id", async () => {
    mockApiFetch.mockResolvedValue(ASSET);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAsset("as1"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(ASSET));
    expect(mockApiFetch).toHaveBeenCalledWith("/assets/as1");
  });

  it("stays disabled (no fetch) while id is undefined", () => {
    mockApiFetch.mockReset();
    const { wrapper } = makeWrapper();

    renderHook(() => useAsset(undefined), { wrapper });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("useCreateAsset", () => {
  it("posts the exact create payload and invalidates the assets queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(ASSET);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateAsset(), { wrapper });

    result.current.mutate({ name: "1967 Mustang", type: "vehicle", currency: "USD" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/assets", {
      method: "POST",
      json: { name: "1967 Mustang", type: "vehicle", currency: "USD" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["assets"] });
    // An asset value change can move a net-worth-sourced goal's progress, so
    // goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useUpdateAsset", () => {
  it("patches the asset and invalidates the assets queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...ASSET, name: "Renamed" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateAsset("as1"), { wrapper });

    result.current.mutate({ name: "Renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/assets/as1", {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["assets"] });
    // An asset value change can move a net-worth-sourced goal's progress, so
    // goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useDeleteAsset", () => {
  it("deletes the asset and invalidates the assets queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteAsset(), { wrapper });

    result.current.mutate("as1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/assets/as1", { method: "DELETE" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["assets"] });
    // An asset value change can move a net-worth-sourced goal's progress, so
    // goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useAddValuation", () => {
  it("posts the valuation and invalidates the assets queries on success", async () => {
    const VALUATION = {
      id: "v1",
      asset_id: "as1",
      value_minor: 4_600_000,
      as_of: "2026-06-01",
      source: "Appraisal",
      is_demo: false,
      created_at: "2026-06-01T00:00:00Z",
    };
    mockApiFetch.mockReset().mockResolvedValue(VALUATION);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useAddValuation("as1"), { wrapper });

    result.current.mutate({ value_minor: 4_600_000, as_of: "2026-06-01", source: "Appraisal" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/assets/as1/valuations", {
      method: "POST",
      json: { value_minor: 4_600_000, as_of: "2026-06-01", source: "Appraisal" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["assets"] });
    // An asset value change can move a net-worth-sourced goal's progress, so
    // goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});
