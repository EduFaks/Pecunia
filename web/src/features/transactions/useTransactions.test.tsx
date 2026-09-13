import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  cleanFilters,
  hasActiveFilters,
  transactionsQueryKey,
  transactionsQueryString,
  useApplyTransactionToLoan,
  useCreateTransaction,
  useDeleteTransaction,
  useRestoreTransaction,
  useUpdateTransaction,
} from "./useTransactions";

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

const TRANSACTION = {
  id: "t1",
  account_id: "a1",
  category_id: null,
  amount_minor: -8499,
  currency: "USD",
  description: "Groceries",
  occurred_on: "2026-09-10",
  is_demo: false,
  deleted_at: null,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

describe("transaction filter helpers", () => {
  it("collapses an empty/blank filter set to the bare unfiltered cache key", () => {
    // No active filter → the same `["transactions"]` slot the unfiltered list
    // has always used (and that every mutation invalidates as a prefix).
    expect(transactionsQueryKey()).toEqual(["transactions"]);
    expect(transactionsQueryKey({})).toEqual(["transactions"]);
    expect(transactionsQueryKey({ q: "   ", accountId: "", categoryId: "" })).toEqual([
      "transactions",
    ]);
  });

  it("makes each active filter combo its own cache entry, never the flat-read key", () => {
    expect(transactionsQueryKey({ accountId: "a1", q: "coffee" })).toEqual([
      "transactions",
      { accountId: "a1", q: "coffee" },
    ]);
    // Distinct combos → distinct keys; the appended part is an object, so it
    // can never collide with `useTransactionList`'s `["transactions", "flat"]`.
    expect(transactionsQueryKey({ q: "a" })).not.toEqual(transactionsQueryKey({ q: "b" }));
    expect(transactionsQueryKey({ accountId: "a1" })[1]).not.toBe("flat");
  });

  it("threads every present filter into the querystring under its server param name", () => {
    const qs = transactionsQueryString(
      {
        q: "cof",
        accountId: "a1",
        categoryId: "c1",
        contactId: "p1",
        type: "income",
        dateFrom: "2026-01-01",
        dateTo: "2026-02-01",
        minAmountMinor: 1000,
        maxAmountMinor: 5000,
      },
      "cursor-1",
      20,
    );
    const params = new URLSearchParams(qs);
    expect(params.get("limit")).toBe("20");
    expect(params.get("q")).toBe("cof");
    expect(params.get("account_id")).toBe("a1");
    expect(params.get("category_id")).toBe("c1");
    expect(params.get("contact_id")).toBe("p1");
    expect(params.get("type")).toBe("income");
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-02-01");
    expect(params.get("min_amount_minor")).toBe("1000");
    expect(params.get("max_amount_minor")).toBe("5000");
    expect(params.get("cursor")).toBe("cursor-1");
  });

  it("omits blank filters and the cursor from the querystring", () => {
    expect(transactionsQueryString({}, null, 20)).toBe("limit=20");
    expect(transactionsQueryString({ q: "  ", categoryId: "" }, null, 20)).toBe("limit=20");
  });

  it("treats blank/empty values as inactive", () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ q: "   " })).toBe(false);
    expect(hasActiveFilters({ accountId: "a1" })).toBe(true);
    expect(cleanFilters({ q: " x ", minAmountMinor: Number.NaN })).toEqual({ q: "x" });
  });
});

describe("useCreateTransaction", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts the exact create payload and invalidates transactions + accounts (balances) + analytics on success", async () => {
    mockApiFetch.mockResolvedValue(TRANSACTION);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateTransaction(), { wrapper });

    result.current.mutate({
      account_id: "a1",
      amount_minor: -8499,
      currency: "USD",
      description: "Groceries",
      occurred_on: "2026-09-10",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transactions", {
      method: "POST",
      json: {
        account_id: "a1",
        amount_minor: -8499,
        currency: "USD",
        description: "Groceries",
        occurred_on: "2026-09-10",
      },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    // The balance-reactivity contract: invalidating the accounts prefix
    // covers both the accounts list and any open account-detail query.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    // A transaction moves cashflow/spending/net-worth, so analytics re-reads too.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    // A transaction can move a net-worth-sourced (or account-sourced) goal's
    // progress, so goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useUpdateTransaction", () => {
  it("patches the transaction and invalidates transactions + accounts + analytics on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...TRANSACTION, description: "Rent" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateTransaction("t1"), { wrapper });

    result.current.mutate({ description: "Rent" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transactions/t1", {
      method: "PATCH",
      json: { description: "Rent" },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    // A transaction moves cashflow/spending/net-worth, so analytics re-reads too.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    // A transaction can move a net-worth-sourced (or account-sourced) goal's
    // progress, so goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useDeleteTransaction", () => {
  it("soft-deletes and invalidates transactions + accounts + analytics on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteTransaction(), { wrapper });

    result.current.mutate("t1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transactions/t1", { method: "DELETE" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    // A transaction moves cashflow/spending/net-worth, so analytics re-reads too.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    // A transaction can move a net-worth-sourced (or account-sourced) goal's
    // progress, so goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useRestoreTransaction", () => {
  it("restores and invalidates transactions + accounts + analytics on success", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRestoreTransaction(), { wrapper });

    result.current.mutate("t1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transactions/t1/restore", { method: "POST" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["accounts"] });
    // A transaction moves cashflow/spending/net-worth, so analytics re-reads too.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    // A transaction can move a net-worth-sourced (or account-sourced) goal's
    // progress, so goals re-read too (L3).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["goals"] });
  });
});

describe("useApplyTransactionToLoan", () => {
  it("posts the loan_id to the apply-to-loan endpoint and invalidates transactions + loans", async () => {
    mockApiFetch.mockReset().mockResolvedValue({
      id: "lp-new",
      loan_id: "l1",
      transaction_id: "t1",
      amount_minor: 8499,
      paid_on: "2026-09-10",
      note: null,
      is_demo: false,
      created_at: "2026-09-10T00:00:00Z",
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useApplyTransactionToLoan(), { wrapper });
    result.current.mutate({ transactionId: "t1", loanId: "l1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/transactions/t1/apply-to-loan", {
      method: "POST",
      json: { loan_id: "l1" },
    });
    // Both ledgers move: the tx gains a loan-payment link, the loan's remaining drops.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["loans"] });
  });
});
