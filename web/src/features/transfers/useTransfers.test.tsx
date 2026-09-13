import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useCreateTransfer,
  useDeleteTransfer,
  useTransfers,
  useUpdateTransfer,
} from "./useTransfers";

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

const TRANSFER = {
  id: "tr1",
  from_account_id: "a1",
  to_account_id: "a2",
  amount_minor: 5000,
  currency: "USD",
  description: "Move to savings",
  occurred_on: "2026-09-11",
  is_demo: false,
  created_at: "2026-09-11T00:00:00Z",
};

/** A transfer touches balances on both legs, so every mutation must refresh
 * transfers, transactions, and accounts (which the dashboard's net-worth/
 * balance reads all key under). */
const INVALIDATED_KEYS = [["transfers"], ["transactions"], ["accounts"]] as const;

describe("useTransfers", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the flat transfers list", async () => {
    mockApiFetch.mockResolvedValue({ items: [TRANSFER], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useTransfers(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transfers?limit=200");
    expect(result.current.data?.items).toEqual([TRANSFER]);
  });
});

describe("useCreateTransfer", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts the create payload and invalidates transfers, transactions, and accounts", async () => {
    mockApiFetch.mockResolvedValue(TRANSFER);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateTransfer(), { wrapper });

    result.current.mutate({
      from_account_id: "a1",
      to_account_id: "a2",
      amount_minor: 5000,
      currency: "USD",
      description: "Move to savings",
      occurred_on: "2026-09-11",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transfers", {
      method: "POST",
      json: {
        from_account_id: "a1",
        to_account_id: "a2",
        amount_minor: 5000,
        currency: "USD",
        description: "Move to savings",
        occurred_on: "2026-09-11",
      },
    });
    for (const queryKey of INVALIDATED_KEYS) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    }
  });
});

describe("useUpdateTransfer", () => {
  it("patches the transfer and invalidates transfers, transactions, and accounts", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...TRANSFER, amount_minor: 7000 });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateTransfer("tr1"), { wrapper });

    result.current.mutate({ amount_minor: 7000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transfers/tr1", {
      method: "PATCH",
      json: { amount_minor: 7000 },
    });
    for (const queryKey of INVALIDATED_KEYS) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    }
  });
});

describe("useDeleteTransfer", () => {
  it("deletes the transfer and invalidates transfers, transactions, and accounts", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteTransfer(), { wrapper });

    result.current.mutate("tr1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transfers/tr1", { method: "DELETE" });
    for (const queryKey of INVALIDATED_KEYS) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    }
  });
});
