import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useArchiveCategory,
  useCategories,
  useCreateCategory,
  useUpdateCategory,
} from "./useCategories";

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

const CATEGORY = {
  id: "c1",
  name: "Groceries",
  kind: "expense",
  color: "#8a8578",
  icon: "shopping-bag",
  archived_at: null,
  is_demo: false,
};

describe("useCategories", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the flat, non-archived-by-default list", async () => {
    mockApiFetch.mockResolvedValue({ items: [CATEGORY], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useCategories(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/categories?include_archived=false&limit=200");
    expect(result.current.data?.items).toEqual([CATEGORY]);
  });

  it("passes include_archived=true through when asked", async () => {
    mockApiFetch.mockResolvedValue({ items: [CATEGORY], next_cursor: null });
    const { wrapper } = makeWrapper();

    renderHook(() => useCategories(true), { wrapper });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith("/categories?include_archived=true&limit=200"),
    );
  });
});

describe("useCreateCategory", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts the exact create payload and invalidates the categories queries on success", async () => {
    mockApiFetch.mockResolvedValue(CATEGORY);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateCategory(), { wrapper });

    result.current.mutate({ name: "Groceries", kind: "expense", color: "#8a8578", icon: "shopping-bag" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/categories", {
      method: "POST",
      json: { name: "Groceries", kind: "expense", color: "#8a8578", icon: "shopping-bag" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["categories"] });
  });
});

describe("useUpdateCategory", () => {
  it("patches the category and invalidates the categories queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...CATEGORY, name: "Food" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateCategory("c1"), { wrapper });

    result.current.mutate({ name: "Food" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/categories/c1", {
      method: "PATCH",
      json: { name: "Food" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["categories"] });
  });
});

describe("useArchiveCategory", () => {
  it("archives the category and invalidates the categories queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useArchiveCategory(), { wrapper });

    result.current.mutate("c1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/categories/c1/archive", { method: "POST" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["categories"] });
  });
});
