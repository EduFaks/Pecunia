import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useCreateGoal,
  useDeleteGoal,
  useGoal,
  useGoals,
  useUpdateGoal,
} from "./useGoals";
import type { GoalOut } from "./useGoals";

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

const GOAL: GoalOut = {
  id: "g1",
  name: "Emergency fund",
  target_minor: 500_000,
  currency: "USD",
  target_date: null,
  source_kind: "manual",
  source_id: null,
  manual_current_minor: 100_000,
  created_at: "2026-09-01T00:00:00Z",
  progress: { current_minor: 100_000, target_minor: 500_000, pct_bps: 2000 },
  eta: { reached_on: null, on_track: false },
};

describe("useGoals", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the flat goal list", async () => {
    mockApiFetch.mockResolvedValue({ items: [GOAL], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useGoals(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/goals?limit=200");
    expect(result.current.data?.items).toEqual([GOAL]);
  });
});

describe("useGoal", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches a single goal by id", async () => {
    mockApiFetch.mockResolvedValue(GOAL);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useGoal("g1"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(GOAL));
    expect(mockApiFetch).toHaveBeenCalledWith("/goals/g1");
  });

  it("stays disabled while id is undefined", () => {
    const { wrapper } = makeWrapper();

    renderHook(() => useGoal(undefined), { wrapper });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("goal mutations", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("creates a goal and invalidates the goals prefix", async () => {
    mockApiFetch.mockResolvedValue(GOAL);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateGoal(), { wrapper });

    result.current.mutate({
      name: "Emergency fund",
      target_minor: 500_000,
      currency: "USD",
      source_kind: "manual",
      manual_current_minor: 100_000,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/goals", {
      method: "POST",
      json: {
        name: "Emergency fund",
        target_minor: 500_000,
        currency: "USD",
        source_kind: "manual",
        manual_current_minor: 100_000,
      },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });

  it("updates a goal and invalidates the goals prefix", async () => {
    mockApiFetch.mockResolvedValue({ ...GOAL, manual_current_minor: 150_000 });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateGoal("g1"), { wrapper });

    result.current.mutate({ manual_current_minor: 150_000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/goals/g1", {
      method: "PATCH",
      json: { manual_current_minor: 150_000 },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });

  it("deletes a goal and invalidates the goals prefix", async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteGoal(), { wrapper });

    result.current.mutate("g1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/goals/g1", { method: "DELETE" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});
