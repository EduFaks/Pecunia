import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import {
  useCreateLoan,
  useDeleteLoan,
  useDeletePayment,
  useLoan,
  useLoanPayments,
  useLoans,
  useRecordPayment,
  useUpdateLoan,
  useUpdateLoanPayment,
} from "./useLoans";

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

const LOAN = {
  id: "l1",
  name: "Car loan",
  direction: "borrowed",
  principal_minor: 2_500_000,
  currency: "USD",
  interest_rate_bps: 425,
  planned_payment_minor: 45_000,
  payment_frequency: "monthly",
  next_due: "2026-10-01",
  opened_on: "2025-01-01",
  description: null,
  is_demo: false,
  created_at: "2026-01-01T00:00:00Z",
  paid_total_minor: 135_000,
  remaining_minor: 2_365_000,
};

const PAYMENT = {
  id: "lp1",
  loan_id: "l1",
  transaction_id: null,
  amount_minor: 45_000,
  paid_on: "2026-09-01",
  note: null,
  is_demo: false,
  created_at: "2026-09-01T00:00:00Z",
};

/** Every loan/payment mutation must refresh the loans prefix AND `["analytics"]`
 * for net worth — but NOT `qk.accounts`: a loan change doesn't move account
 * balances, so that over-broad invalidation was trimmed (the net-worth tile
 * still updates via the loans prefix). */
function expectNetWorthInvalidations(invalidateSpy: MockInstance<QueryClient["invalidateQueries"]>) {
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["loans"] });
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["analytics"] });
  expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["accounts"] });
}

describe("useLoans", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches the loan list", async () => {
    mockApiFetch.mockResolvedValue({ items: [LOAN], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useLoans(), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toEqual([LOAN]));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans?limit=200");
  });
});

describe("useLoan", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches a single loan by id", async () => {
    mockApiFetch.mockResolvedValue(LOAN);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useLoan("l1"), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(LOAN));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1");
  });

  it("stays disabled (no fetch) while id is undefined", () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useLoan(undefined), { wrapper });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("useLoanPayments", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches a loan's payments ledger", async () => {
    mockApiFetch.mockResolvedValue({ items: [PAYMENT], next_cursor: null });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useLoanPayments("l1"), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toEqual([PAYMENT]));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments?limit=200");
  });

  it("stays disabled while loanId is undefined", () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useLoanPayments(undefined), { wrapper });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe("useCreateLoan", () => {
  it("posts the create payload and invalidates loans + net-worth keys", async () => {
    mockApiFetch.mockReset().mockResolvedValue(LOAN);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateLoan(), { wrapper });
    result.current.mutate({
      name: "Car loan",
      direction: "borrowed",
      principal_minor: 2_500_000,
      currency: "USD",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans", {
      method: "POST",
      json: { name: "Car loan", direction: "borrowed", principal_minor: 2_500_000, currency: "USD" },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useUpdateLoan", () => {
  it("patches the loan and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...LOAN, name: "Renamed" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateLoan("l1"), { wrapper });
    result.current.mutate({ name: "Renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1", {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useDeleteLoan", () => {
  it("deletes the loan and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteLoan(), { wrapper });
    result.current.mutate("l1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1", { method: "DELETE" });
    expectNetWorthInvalidations(invalidateSpy);
  });
});

describe("useRecordPayment", () => {
  it("posts the payment and invalidates loans + net-worth keys", async () => {
    mockApiFetch.mockReset().mockResolvedValue(PAYMENT);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRecordPayment("l1"), { wrapper });
    result.current.mutate({ amount_minor: 45_000, paid_on: "2026-09-01", note: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments", {
      method: "POST",
      json: { amount_minor: 45_000, paid_on: "2026-09-01", note: null },
    });
    expectNetWorthInvalidations(invalidateSpy);
  });

  it("passes an optional transaction_id through and refreshes transactions too (a tx's linkage changed)", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...PAYMENT, transaction_id: "tx1" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRecordPayment("l1"), { wrapper });
    result.current.mutate({
      amount_minor: 45_000,
      paid_on: "2026-09-01",
      note: null,
      transaction_id: "tx1",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments", {
      method: "POST",
      json: { amount_minor: 45_000, paid_on: "2026-09-01", note: null, transaction_id: "tx1" },
    });
    expectNetWorthInvalidations(invalidateSpy);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
  });
});

describe("useUpdateLoanPayment", () => {
  it("attaches a transaction (PATCH transaction_id) and invalidates loans + transactions", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...PAYMENT, transaction_id: "tx1" });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateLoanPayment("l1"), { wrapper });
    result.current.mutate({ paymentId: "lp1", payload: { transaction_id: "tx1" } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments/lp1", {
      method: "PATCH",
      json: { transaction_id: "tx1" },
    });
    expectNetWorthInvalidations(invalidateSpy);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
  });

  it("detaches a transaction with an explicit null", async () => {
    mockApiFetch.mockReset().mockResolvedValue({ ...PAYMENT, transaction_id: null });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateLoanPayment("l1"), { wrapper });
    result.current.mutate({ paymentId: "lp1", payload: { transaction_id: null } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments/lp1", {
      method: "PATCH",
      json: { transaction_id: null },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["transactions"] });
  });
});

describe("useDeletePayment", () => {
  it("deletes the payment and invalidates", async () => {
    mockApiFetch.mockReset().mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeletePayment("l1"), { wrapper });
    result.current.mutate("lp1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiFetch).toHaveBeenCalledWith("/loans/l1/payments/lp1", { method: "DELETE" });
    expectNetWorthInvalidations(invalidateSpy);
  });
});
