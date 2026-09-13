import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useAddProjectItem,
  useAttachItemTransaction,
  useCreateProject,
  useDeleteProject,
  useDetachItemTransaction,
  useProject,
  useProjectList,
  useUpdateProject,
  useUpdateProjectItem,
} from "./useProjects";

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

const PROJECT = {
  id: "p1",
  name: "New roof",
  description: null,
  target_amount_minor: 1_000_000,
  currency: "USD",
  status: "active",
  type: "spending",
  planned_minor: 250_000,
  actual_minor: 100_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("useProject", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches a single project by id", async () => {
    mockApiFetch.mockResolvedValue(PROJECT);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useProject("p1"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(PROJECT));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1");
  });

  it("stays disabled (no fetch) while id is undefined", () => {
    mockApiFetch.mockReset();
    const { wrapper } = makeWrapper();

    renderHook(() => useProject(undefined), { wrapper });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("useCreateProject", () => {
  it("posts the exact create payload and invalidates the projects queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(PROJECT);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateProject(), { wrapper });

    result.current.mutate({
      name: "New roof",
      currency: "USD",
      target_amount_minor: 1_000_000,
      status: "active",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects", {
      method: "POST",
      json: { name: "New roof", currency: "USD", target_amount_minor: 1_000_000, status: "active" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });
});

describe("useUpdateProject", () => {
  it("patches the project and invalidates the projects queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...PROJECT, status: "completed" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateProject("p1"), { wrapper });

    result.current.mutate({ status: "completed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1", {
      method: "PATCH",
      json: { status: "completed" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });
});

describe("useDeleteProject", () => {
  it("deletes the project and invalidates the projects queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteProject(), { wrapper });

    result.current.mutate("p1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1", { method: "DELETE" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });
});

describe("useAddProjectItem", () => {
  it("posts the item and invalidates the projects queries on success", async () => {
    const ITEM = { id: "i1", project_id: "p1", name: "Shingles", amount_minor: 200_000, is_demo: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
    mockApiFetch.mockReset().mockResolvedValue(ITEM);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useAddProjectItem("p1"), { wrapper });

    result.current.mutate({ name: "Shingles", amount_minor: 200_000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items", {
      method: "POST",
      json: { name: "Shingles", amount_minor: 200_000 },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });
});

describe("useUpdateProjectItem", () => {
  it("patches the item and invalidates the projects queries on success", async () => {
    const ITEM = { id: "i1", project_id: "p1", name: "Shingles", amount_minor: 250_000, is_demo: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
    mockApiFetch.mockReset().mockResolvedValue(ITEM);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateProjectItem("p1", "i1"), { wrapper });

    result.current.mutate({ amount_minor: 250_000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items/i1", {
      method: "PATCH",
      json: { amount_minor: 250_000 },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });
});

const BOUGHT_ITEM = {
  id: "i1",
  project_id: "p1",
  transaction_id: "tx1",
  name: "Shingles",
  amount_minor: 250_000,
  actual_minor: 240_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("useAttachItemTransaction", () => {
  it("posts the transaction id and invalidates both the projects and transactions queries", async () => {
    mockApiFetch.mockReset().mockResolvedValue(BOUGHT_ITEM);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useAttachItemTransaction("p1", "i1"), { wrapper });

    result.current.mutate("tx1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items/i1/attach", {
      method: "POST",
      json: { transaction_id: "tx1" },
    });
    // A part's link touches the project (its actual moves), its items, AND
    // the linked transaction's project_id — so both prefixes are invalidated.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
  });
});

describe("useDetachItemTransaction", () => {
  it("posts detach and invalidates both the projects and transactions queries", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...BOUGHT_ITEM, transaction_id: null, actual_minor: null });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDetachItemTransaction("p1", "i1"), { wrapper });

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/items/i1/detach", { method: "POST" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
  });
});

describe("useProjectList", () => {
  it("reads a bounded flat page under a key distinct from the infinite list", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ items: [PROJECT], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useProjectList(), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toEqual([PROJECT]));
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/projects\?limit=/));
  });
});
