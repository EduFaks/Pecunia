import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useAccount,
  useAccounts,
  useArchiveAccount,
  useCreateAccount,
  useUpdateAccount,
} from "./useAccounts";

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

const ACCOUNT = {
  id: "a1",
  name: "Checking",
  type: "checking",
  currency: "USD",
  initial_balance_minor: 0,
  balance_minor: 500,
  is_demo: false,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("useAccounts", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the non-archived account list by default", async () => {
    mockApiFetch.mockResolvedValue({ items: [ACCOUNT], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAccounts(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/accounts\?include_archived=false&limit=\d+$/),
    );
    expect(result.current.data?.items).toEqual([ACCOUNT]);
  });

  it("includes archived accounts when asked", async () => {
    mockApiFetch.mockResolvedValue({ items: [], next_cursor: null });
    const { wrapper } = makeWrapper();

    renderHook(() => useAccounts(true), { wrapper });

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^\/accounts\?include_archived=true&limit=\d+$/),
      ),
    );
  });
});

describe("useAccount", () => {
  it("fetches a single account by id", async () => {
    mockApiFetch.mockReset().mockResolvedValue(ACCOUNT);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAccount("a1"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(ACCOUNT));
    expect(mockApiFetch).toHaveBeenCalledWith("/accounts/a1");
  });

  it("stays disabled (no fetch) while id is undefined", () => {
    mockApiFetch.mockReset();
    const { wrapper } = makeWrapper();

    renderHook(() => useAccount(undefined), { wrapper });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("useCreateAccount", () => {
  it("posts the exact create payload and invalidates the accounts queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(ACCOUNT);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateAccount(), { wrapper });

    result.current.mutate({
      name: "Checking",
      type: "checking",
      currency: "USD",
      initial_balance_minor: 500,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/accounts", {
      method: "POST",
      json: { name: "Checking", type: "checking", currency: "USD", initial_balance_minor: 500 },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    // An account change (balance, currency) can move an account- or
    // net-worth-sourced goal's progress, so goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useUpdateAccount", () => {
  it("patches the account and invalidates the accounts queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...ACCOUNT, name: "Renamed" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateAccount("a1"), { wrapper });

    result.current.mutate({ name: "Renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/accounts/a1", {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    // An account change (balance, currency) can move an account- or
    // net-worth-sourced goal's progress, so goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useArchiveAccount", () => {
  it("posts the archive action and invalidates the accounts queries on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useArchiveAccount(), { wrapper });

    result.current.mutate("a1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/accounts/a1/archive", { method: "POST" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    // An account change (balance, currency) can move an account- or
    // net-worth-sourced goal's progress, so goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});
