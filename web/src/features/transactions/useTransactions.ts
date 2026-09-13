/**
 * Mutation hooks for the `/transactions` resource. `TransactionsScreen` and
 * `AccountDetail` both read transactions through `DataList` directly (a
 * keyset-paginated GET has no useful non-paginated hook shape to share), so
 * this file only carries the writes: create/update/soft-delete/restore.
 *
 * Every mutation invalidates three prefixes on success:
 *   - `qk.transactions()` (`["transactions"]`) — the unscoped key, which is
 *     a prefix of every account-scoped variant (`qk.transactions(accountId)`
 *     = `["transactions", {accountId}]`), so one invalidation refreshes
 *     every transactions list currently mounted, filtered or not.
 *   - `qk.accounts` (`["accounts"]`) — a transaction changes its account's
 *     `balance_minor`, and this prefix covers both the accounts list and
 *     any open `qk.account(id)` detail query (`useAccounts.ts`'s docstring
 *     explains the same partial-match mechanics). This is the balance-
 *     reactivity contract: a mutation here always keeps every visible
 *     balance in sync, without either screen having to know about the
 *     other.
 *   - `["analytics"]` — a transaction moves cashflow, spending, and net
 *     worth, so every analytics window (`qk.analytics.*` all nest under
 *     this shared prefix) must re-read. This mirrors how Planned's
 *     post/skip refresh the finance surfaces (`features/planned/usePlanned.ts`).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import type { LoanPaymentOut } from "../loans/useLoans";

/** Mirrors `TransactionOut` (`api/src/pecunia/api/transactions.py`). A
 * transaction can be linked to a project (`project_id`), the mirror of
 * `category_id`/`contact_id`; marking a project part bought sets it too.
 *
 * `transfer_id` is set on a transfer's two legs (null on every ordinary
 * transaction). It's the read-only marker the transaction API returns but
 * never accepts — a leg is created/edited/deleted only through the transfers
 * API (the transaction API 409s `MANAGED_BY_TRANSFER` on a leg), so the UI
 * uses it to label a leg ("Transfer to/from …") and route its edit to the
 * transfer editor. See `features/transfers/`. */
export interface TransactionOut {
  id: string;
  account_id: string;
  category_id: string | null;
  contact_id: string | null;
  project_id: string | null;
  transfer_id: string | null;
  amount_minor: number;
  currency: string;
  description: string;
  occurred_on: string;
  is_demo: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionPage {
  items: TransactionOut[];
  next_cursor: string | null;
}

/** The three-way partition the list's `type` filter offers, matching the
 * server's definitions (`api/src/pecunia/services/transactions.py`): `income`
 * = a positive non-transfer, `expense` = a negative non-transfer, `transfer` =
 * either leg of a transfer. */
export type TransactionType = "income" | "expense" | "transfer";

/**
 * The optional search/filter set the transactions list accepts, threaded by
 * `TransactionsScreen` into both the cache key (`transactionsQueryKey`) and
 * the request (`transactionsQueryString`). Every field is optional and ANDed
 * server-side; a blank/whitespace `q`, an empty-string id, or an `undefined`
 * amount is treated as "not set" (see `cleanFilters`), so clearing a control
 * collapses back toward the bare unfiltered list. Amounts are integer minor
 * units (CONVENTIONS §4); the range filters on magnitude, so it spans both an
 * income and an expense of the same size.
 */
export interface TransactionFilters {
  q?: string;
  accountId?: string;
  categoryId?: string;
  contactId?: string;
  type?: TransactionType;
  dateFrom?: string;
  dateTo?: string;
  minAmountMinor?: number;
  maxAmountMinor?: number;
}

/** Each filter's querystring param name — the read side's mirror of the
 * server params Task 1 added. `from`/`to` alias the dates like the analytics
 * routes. Kept as one table so `transactionsQueryString` (below) and any
 * future reader can't drift from the field names. */
const FILTER_PARAM: Record<keyof TransactionFilters, string> = {
  q: "q",
  accountId: "account_id",
  categoryId: "category_id",
  contactId: "contact_id",
  type: "type",
  dateFrom: "from",
  dateTo: "to",
  minAmountMinor: "min_amount_minor",
  maxAmountMinor: "max_amount_minor",
};

/** Drops the "not set" filters — blank/whitespace `q`, empty-string ids/dates,
 * `undefined`/`NaN` amounts — so both the key and the querystring agree on
 * exactly which filters are active. The one place "is this filter set?" is
 * decided; `hasActiveFilters` reuses it. */
export function cleanFilters(filters: TransactionFilters = {}): Partial<TransactionFilters> {
  const clean: Partial<TransactionFilters> = {};
  const q = filters.q?.trim();
  if (q) clean.q = q;
  if (filters.accountId) clean.accountId = filters.accountId;
  if (filters.categoryId) clean.categoryId = filters.categoryId;
  if (filters.contactId) clean.contactId = filters.contactId;
  if (filters.type) clean.type = filters.type;
  if (filters.dateFrom) clean.dateFrom = filters.dateFrom;
  if (filters.dateTo) clean.dateTo = filters.dateTo;
  if (typeof filters.minAmountMinor === "number" && !Number.isNaN(filters.minAmountMinor)) {
    clean.minAmountMinor = filters.minAmountMinor;
  }
  if (typeof filters.maxAmountMinor === "number" && !Number.isNaN(filters.maxAmountMinor)) {
    clean.maxAmountMinor = filters.maxAmountMinor;
  }
  return clean;
}

/** True when any filter is set — drives `TransactionsScreen`'s choice between
 * the first-run "no transactions yet" empty state and the "nothing matches
 * these filters" one, and whether to render the active-filter chip row. */
export function hasActiveFilters(filters: TransactionFilters): boolean {
  return Object.keys(cleanFilters(filters)).length > 0;
}

/**
 * The cache key for a filtered transactions list. With no active filter it
 * collapses to the bare `qk.transactions()` prefix (`["transactions"]`) so the
 * unfiltered list keeps its existing slot; any active filter makes a distinct
 * slot (`["transactions", {…}]`) — each combo its own cache entry — that still
 * falls under the `["transactions"]` prefix every mutation invalidates. The
 * appended object never equals the `"flat"` string `useTransactionList`
 * suffixes with, so this keyset list never collides with that bounded read
 * (the list-vs-infinite key discipline). TanStack Query hashes object keys
 * order-independently, so field order here is irrelevant to identity.
 */
export function transactionsQueryKey(filters?: TransactionFilters): QueryKey {
  const clean = cleanFilters(filters);
  return Object.keys(clean).length === 0 ? qk.transactions() : [...qk.transactions(), clean];
}

/**
 * Builds the `/transactions` querystring for one keyset page under `filters`,
 * mirroring `transactionsQueryKey`'s present-value rules (via `cleanFilters`)
 * so the request and the cache key always agree on what "filtered" means.
 */
export function transactionsQueryString(
  filters: TransactionFilters | undefined,
  cursor: string | null,
  limit: number,
): string {
  const params = new URLSearchParams({ limit: String(limit) });
  const clean = cleanFilters(filters);
  for (const [field, value] of Object.entries(clean)) {
    params.set(FILTER_PARAM[field as keyof TransactionFilters], String(value));
  }
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** Mirrors `TransactionIn`. */
export interface CreateTransactionPayload {
  account_id: string;
  category_id?: string | null;
  contact_id?: string | null;
  project_id?: string | null;
  amount_minor: number;
  currency: string;
  description: string;
  occurred_on: string;
}

/** Mirrors `TransactionUpdate` — every field optional, only what changed is sent. */
export interface UpdateTransactionPayload {
  account_id?: string;
  category_id?: string | null;
  contact_id?: string | null;
  project_id?: string | null;
  amount_minor?: number;
  currency?: string;
  description?: string;
  occurred_on?: string;
}

/** Comfortably covers a recent slice of the workspace's transactions in one
 * request — enough for the `TransactionPicker` to find one to attach. */
const TRANSACTIONS_LIST_LIMIT = 200;

/** A bounded flat page of the workspace's transactions, powering the
 * `TransactionPicker` (mark-a-part-bought) — the same self-contained read
 * `useContacts` gives `ContactPicker`. Keyed with a `"flat"` suffix
 * (`["transactions", "flat"]`) so it never collides with the
 * `useInfiniteQuery` lists `TransactionsScreen`/`AccountDetail` mount under
 * the bare `qk.transactions()` prefix — yet every mutation here (and the
 * project attach/detach mutations) invalidates that prefix, refreshing this
 * list too via TanStack Query's partial match.
 *
 * Transactions are append-only/unbounded (unlike the small contact set), so
 * this reads a generous recent page rather than the entire history — a
 * finder for a recent transaction to attach, not an exhaustive browser. */
export function useTransactionList() {
  return useQuery({
    queryKey: [...qk.transactions(), "flat"],
    queryFn: () => apiFetch<TransactionPage>(`/transactions?limit=${TRANSACTIONS_LIST_LIMIT}`),
  });
}

function invalidateAfterTransactionChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.transactions() });
  void queryClient.invalidateQueries({ queryKey: qk.accounts });
  void queryClient.invalidateQueries({ queryKey: ["analytics"] });
}

export function useCreateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTransactionPayload) =>
      apiFetch<TransactionOut>("/transactions", { method: "POST", json: payload }),
    onSuccess: () => invalidateAfterTransactionChange(queryClient),
  });
}

export function useUpdateTransaction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTransactionPayload) =>
      apiFetch<TransactionOut>(`/transactions/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => invalidateAfterTransactionChange(queryClient),
  });
}

/** Soft delete (`DELETE /transactions/{id}` → 204). Takes the transaction id
 * as the mutation argument, same shape as `useArchiveAccount` — fired from
 * a list row that already has the id, with no per-row hook instantiation
 * needed. */
export function useDeleteTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/transactions/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateAfterTransactionChange(queryClient),
  });
}

/** `POST /transactions/{id}/restore` → 204 — the undo half of soft delete. */
export function useRestoreTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/transactions/${id}/restore`, { method: "POST" }),
    onSuccess: () => invalidateAfterTransactionChange(queryClient),
  });
}

/** `POST /transactions/{id}/apply-to-loan` — the transaction-side entry point
 * of loan↔transaction linking: creates a loan payment funded by this
 * transaction (the backend derives the amount from the tx magnitude and the
 * date from its `occurred_on`, then links it), the mirror of `PaymentForm`'s
 * attach flow. Rejects with `TRANSACTION_ALREADY_LINKED` (409) if the
 * transaction already funds a loan payment, or `LOAN_NOT_FOUND`/
 * `TRANSACTION_NOT_FOUND` (404).
 *
 * Invalidates `qk.transactions()` (the tx gains a loan-payment link) AND
 * `qk.loans` (the loan's remaining/tile drops). Analytics is left alone: a
 * debt payment is a net-worth wash (the tx already moved the account when it
 * was created), and the loan's remaining re-reads via `qk.loans` regardless. */
export function useApplyTransactionToLoan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ transactionId, loanId }: { transactionId: string; loanId: string }) =>
      apiFetch<LoanPaymentOut>(`/transactions/${transactionId}/apply-to-loan`, {
        method: "POST",
        json: { loan_id: loanId },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.transactions() });
      void queryClient.invalidateQueries({ queryKey: qk.loans });
    },
  });
}
