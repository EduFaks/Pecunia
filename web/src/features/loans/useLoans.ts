/**
 * Query/mutation hooks for the `/loans` resource and its nested
 * `/loans/{id}/payments` sub-resource (the Loans domain, v1.1). A single
 * bounded flat read per collection (`useLoans`, `useLoanPayments`) plus
 * create/update/delete mutations for the loan and record/delete for its
 * payments — the same shape `features/portfolio/usePortfolios.ts` uses.
 *
 * A workspace's loans (a handful of debts/receivables) and a loan's payments
 * are small, user-managed sets — like portfolios/contacts, not an unbounded
 * append-only log — so both hooks read a generous first page rather than
 * walking a keyset `DataList`. The endpoints are still keyset-paginated
 * server-side (CONVENTIONS §6); this bounded fetch just consumes the first
 * page, exactly `usePortfolios`'s rationale.
 *
 * **Invalidation contract:** every mutation here calls `invalidateLoans`,
 * which invalidates the single top-level `qk.loans` key — a prefix of
 * `qk.loan(id)` and `qk.loanPayments(id)` and both hooks' `"flat"` variants,
 * so one call refreshes the list, every open detail, and every open payments
 * ledger (TanStack's partial-match invalidation, same as `qk.portfolios`
 * covering `qk.holdings`). It ALSO invalidates `["analytics"]` — the
 * net-worth-over-time series includes each loan's remaining balance per
 * currency via backend snapshots — since any loan/payment change moves net
 * worth (a borrowed loan is a liability, a lent one a receivable). It does NOT
 * touch `qk.accounts`: a loan change never moves an account balance, and the
 * dashboard's net-worth tile reads loans through this very `qk.loans` prefix
 * (so the tile still updates), keeping the invalidation to exactly the keys a
 * loan change affects.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** A loan's side: `borrowed` is money you owe (a liability that subtracts
 * from net worth); `lent` is money owed to you (a receivable that adds). */
export type LoanDirection = "borrowed" | "lent";

/** How often the planned payment recurs. `null` when the loan has no set
 * schedule. */
export type PaymentFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** Mirrors `LoanOut` (`api/src/pecunia/api/loans.py`). `paid_total_minor` is
 * Σ payments and `remaining_minor` is `max(principal − paid_total, 0)` —
 * both computed server-side, integer minor units. `interest_rate_bps` is
 * stored in basis points for DISPLAY only (V1 does not amortize interest into
 * `remaining_minor`). */
export interface LoanOut {
  id: string;
  name: string;
  direction: LoanDirection;
  principal_minor: number;
  currency: string;
  interest_rate_bps: number | null;
  planned_payment_minor: number | null;
  payment_frequency: PaymentFrequency | null;
  next_due: string | null;
  opened_on: string | null;
  description: string | null;
  is_demo: boolean;
  created_at: string;
  paid_total_minor: number;
  remaining_minor: number;
}

export interface LoanPage {
  items: LoanOut[];
  next_cursor: string | null;
}

/** Mirrors `LoanPaymentOut`. A payment carries no currency of its own — it is
 * always in the parent loan's currency. `amount_minor` is a positive payment
 * magnitude (integer minor units). */
export interface LoanPaymentOut {
  id: string;
  loan_id: string;
  /** The account transaction that funded this payment, or `null` when the
   * payment isn't linked to one. Set either by recording/editing the payment
   * with a `transaction_id`, or by applying a transaction to the loan. */
  transaction_id: string | null;
  amount_minor: number;
  paid_on: string;
  note: string | null;
  is_demo: boolean;
  created_at: string;
}

export interface LoanPaymentPage {
  items: LoanPaymentOut[];
  next_cursor: string | null;
}

/** Mirrors `LoanIn`. `direction` defaults to `borrowed` server-side; the form
 * always sends it explicitly. */
export interface CreateLoanPayload {
  name: string;
  direction: LoanDirection;
  principal_minor: number;
  currency: string;
  interest_rate_bps?: number | null;
  planned_payment_minor?: number | null;
  payment_frequency?: PaymentFrequency | null;
  next_due?: string | null;
  opened_on?: string | null;
  description?: string | null;
}

/** Mirrors `LoanUpdate` — every field optional, only what changed is sent. */
export interface UpdateLoanPayload {
  name?: string;
  direction?: LoanDirection;
  principal_minor?: number;
  currency?: string;
  interest_rate_bps?: number | null;
  planned_payment_minor?: number | null;
  payment_frequency?: PaymentFrequency | null;
  next_due?: string | null;
  opened_on?: string | null;
  description?: string | null;
}

/** Mirrors `LoanPaymentIn`. `transaction_id` is optional — supplied only when
 * the payment is linked to an existing account transaction (the loan-side
 * attach flow in `PaymentForm`). */
export interface RecordPaymentPayload {
  amount_minor: number;
  paid_on: string;
  note?: string | null;
  transaction_id?: string | null;
}

/** Mirrors `LoanPaymentUpdate` — every field optional, only what changed is
 * sent. `transaction_id` attaches (a uuid) or detaches (an explicit `null`)
 * the funding transaction; omit it to leave the link untouched. */
export interface UpdateLoanPaymentPayload {
  amount_minor?: number;
  paid_on?: string;
  note?: string | null;
  transaction_id?: string | null;
}

/** Comfortably covers a personal workspace's full loan/payment list in one
 * request — same rationale/limit as `usePortfolios`'s bounded read
 * (`pecunia.pagination.MAX_LIMIT` is 200). */
const LIST_LIMIT = 200;

/**
 * The workspace's loans, each carrying its computed `paid_total_minor` and
 * `remaining_minor`. Keyed with a `"flat"` suffix (`[...qk.loans, "flat"]`) —
 * same collision-avoidance move as `usePortfolios` — so a future keyset read
 * of `qk.loans` never collides with this shape, while every mutation below
 * still invalidates the bare prefix. Shared by `LoansScreen` and the
 * Dashboard's net-worth tile.
 */
export function useLoans() {
  return useQuery({
    queryKey: [...qk.loans, "flat"],
    queryFn: () => apiFetch<LoanPage>(`/loans?limit=${LIST_LIMIT}`),
  });
}

/** A single loan by id, including its live `remaining_minor` — disabled while
 * `id` is undefined, same pattern as `usePortfolio`. */
export function useLoan(id: string | undefined) {
  return useQuery({
    queryKey: qk.loan(id ?? ""),
    queryFn: () => apiFetch<LoanOut>(`/loans/${id}`),
    enabled: id !== undefined,
  });
}

/** One loan's payments ledger (flat bounded read, `"flat"`-suffixed under
 * `qk.loanPayments(id)`). Disabled while `loanId` is undefined. */
export function useLoanPayments(loanId: string | undefined) {
  return useQuery({
    queryKey: [...qk.loanPayments(loanId ?? ""), "flat"],
    queryFn: () => apiFetch<LoanPaymentPage>(`/loans/${loanId}/payments?limit=${LIST_LIMIT}`),
    enabled: loanId !== undefined,
  });
}

/** Refreshes the loans prefix (list, every detail, every payments ledger —
 * all nest under `qk.loans`) plus `["analytics"]` (the shared analytics prefix
 * documented in `lib/queries.ts`) for the net-worth-over-time series. A
 * loan/payment change does NOT move account balances, so `qk.accounts` is
 * deliberately left out — the net-worth tile reads loans via `qk.loans` and
 * still updates. */
function invalidateLoans(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.loans });
  void queryClient.invalidateQueries({ queryKey: ["analytics"] });
}

/** The invalidation for payment mutations that can attach/detach a funding
 * transaction (record + update payment). On top of the loans + net-worth keys
 * (`invalidateLoans`), it also refreshes `qk.transactions()` because a payment's
 * `transaction_id` moving means a transaction's linkage changed — every open
 * transactions list (and the bounded `useTransactionList` that `LoanDetail`
 * resolves the linked transaction through) must re-read. */
function invalidateLoansAndTransactions(queryClient: QueryClient): void {
  invalidateLoans(queryClient);
  void queryClient.invalidateQueries({ queryKey: qk.transactions() });
}

export function useCreateLoan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateLoanPayload) =>
      apiFetch<LoanOut>("/loans", { method: "POST", json: payload }),
    onSuccess: () => invalidateLoans(queryClient),
  });
}

export function useUpdateLoan(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateLoanPayload) =>
      apiFetch<LoanOut>(`/loans/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => invalidateLoans(queryClient),
  });
}

/** Hard delete (`DELETE /loans/{id}` → 204, cascades to its payments). Takes
 * the loan id as the mutation argument. */
export function useDeleteLoan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/loans/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateLoans(queryClient),
  });
}

/** `POST /loans/{id}/payments` — recording a payment is what moves a loan's
 * `paid_total_minor`/`remaining_minor` and thus net worth, so this invalidates
 * the loans + net-worth keys. It ALSO refreshes `qk.transactions()`: a payment
 * may carry a `transaction_id` (the loan-side attach), which links a transaction
 * to it, so every transactions list must re-read to reflect that link. */
export function useRecordPayment(loanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecordPaymentPayload) =>
      apiFetch<LoanPaymentOut>(`/loans/${loanId}/payments`, { method: "POST", json: payload }),
    onSuccess: () => invalidateLoansAndTransactions(queryClient),
  });
}

/** `PATCH /loans/{id}/payments/{pid}` — edits a payment and/or attaches
 * (`transaction_id` = a uuid) or detaches (`transaction_id` = `null`) its
 * funding transaction. Takes `{ paymentId, payload }` so a single hook
 * instance serves every row in the ledger. Same invalidation as
 * `useRecordPayment` (loans + net worth + transactions), since editing the
 * amount moves the loan's remaining and attaching/detaching moves a
 * transaction's linkage. */
export function useUpdateLoanPayment(loanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, payload }: { paymentId: string; payload: UpdateLoanPaymentPayload }) =>
      apiFetch<LoanPaymentOut>(`/loans/${loanId}/payments/${paymentId}`, {
        method: "PATCH",
        json: payload,
      }),
    onSuccess: () => invalidateLoansAndTransactions(queryClient),
  });
}

/** Hard delete (`DELETE /loans/{id}/payments/{pid}` → 204). Takes the payment
 * id as the mutation argument. */
export function useDeletePayment(loanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) =>
      apiFetch<void>(`/loans/${loanId}/payments/${paymentId}`, { method: "DELETE" }),
    onSuccess: () => invalidateLoans(queryClient),
  });
}
