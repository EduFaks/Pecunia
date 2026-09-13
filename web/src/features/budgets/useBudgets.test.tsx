import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { useCreateBudget, useDeleteBudget, useUpdateBudget } from "./useBudgets";

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

const BUDGET = {
  id: "b1",
  name: "Groceries",
  category_id: "c-groceries",
  period: "monthly",
  amount_minor: 60_000,
  currency: "USD",
  actual_minor: 30_000,
  remaining_minor: 30_000,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("useCreateBudget", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts the exact create payload and invalidates the budgets queries on success", async () => {
    mockApiFetch.mockResolvedValue(BUDGET);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateBudget(), { wrapper });

    result.current.mutate({
      name: "Groceries",
      category_id: "c-groceries",
      period: "monthly",
      amount_minor: 60_000,
      currency: "USD",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/budgets", {
      method: "POST",
      json: {
        name: "Groceries",
        category_id: "c-groceries",
        period: "monthly",
        amount_minor: 60_000,
        currency: "USD",
      },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["budgets"] });
  });
});

describe("useUpdateBudget", () => {
  it("patches the budget and invalidates the budgets queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...BUDGET, amount_minor: 70_000 });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateBudget("b1"), { wrapper });

    result.current.mutate({ amount_minor: 70_000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/budgets/b1", {
      method: "PATCH",
      json: { amount_minor: 70_000 },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["budgets"] });
  });
});

describe("useDeleteBudget", () => {
  it("deletes the budget and invalidates the budgets queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteBudget(), { wrapper });

    result.current.mutate("b1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/budgets/b1", { method: "DELETE" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["budgets"] });
  });
});
