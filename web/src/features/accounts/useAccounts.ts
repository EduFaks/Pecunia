/**
 * Query/mutation hooks for the `/accounts` resource. Mirrors `lib/setup.ts`'s
 * "wrap `useQuery` in a named hook returning a small interface" pattern
 * (CONVENTIONS §9.9) — screens never see a raw `UseQueryResult`.
 *
 * Every mutation invalidates `qk.accounts` (`["accounts"]`) rather than
 * naming individual detail keys: TanStack Query's default partial-match
 * invalidation treats that as a *prefix*, so it also catches every
 * `qk.account(id)` detail query and every filtered variant of this file's
 * own `useAccounts` (`[...qk.accounts, "flat", {includeArchived}]`) in one
 * call — see `lib/queries.ts`'s docstring. This is also how a transaction
 * mutation (`features/transactions/useTransactions.ts`) keeps account
 * balances reactive: it invalidates this same `qk.accounts` prefix.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `AccountType` (`api/src/pecunia/models/account.py`). */
export type AccountType = "checking" | "savings" | "credit_card" | "cash" | "brokerage" | "wallet";

/** Mirrors `AccountOut` (`api/src/pecunia/api/accounts.py`). */
export interface AccountOut {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  initial_balance_minor: number;
  balance_minor: number;
  is_demo: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountPage {
  items: AccountOut[];
  next_cursor: string | null;
}

/** Mirrors `AccountIn`. */
export interface CreateAccountPayload {
  name: string;
  type: AccountType;
  currency: string;
  initial_balance_minor?: number;
}

/** Mirrors `AccountUpdate` — every field optional, only what changed is sent. */
export interface UpdateAccountPayload {
  name?: string;
  type?: AccountType;
  currency?: string;
}

/** Comfortably covers a personal workspace's full account list in one
 * request — `AccountsScreen`'s own list still walks pages via `DataList`;
 * this is for callers (account Selects, filters) that want "every account"
 * flat, not a page at a time. */
const ACCOUNTS_LIST_LIMIT = 200;

/** The flat (non-paginated) account list — powers account-picker `Select`s
 * (`TransactionForm`, `TransactionsScreen`'s filter) and anything else that
 * needs every account at once.
 *
 * Keyed with a `"flat"` suffix (`[...qk.accounts, "flat", {includeArchived}]`)
 * — the same move `Dashboard`'s bounded reads make with `"dashboard"` and
 * `AssetDetail`'s chart fetch makes with `"chart"` (see that file's
 * docstring) — so this can never collide with `AccountsScreen`'s
 * `DataList`, which reads the *same* `{includeArchived}` filter through
 * `useInfiniteQuery` under the bare `[...qk.accounts, {includeArchived}]`
 * key. Without the suffix, once this hook populated that key with its flat
 * `{items, next_cursor}` payload, `AccountsScreen`'s `useInfiniteQuery`
 * would read it back as if it were an already-paginated `{pages,
 * pageParams}` result and crash calling `.pages.flatMap` on the missing
 * `.pages` — exactly what happened visiting `/transactions` (which calls
 * `useAccounts(true)`) and then toggling "Show archived" on `/accounts`.
 * The suffix is still a nested key under `qk.accounts`, so every mutation's
 * `invalidateQueries({ queryKey: qk.accounts })` still covers it via
 * TanStack's prefix match. */
export function useAccounts(includeArchived = false) {
  return useQuery({
    queryKey: [...qk.accounts, "flat", { includeArchived }],
    queryFn: () =>
      apiFetch<AccountPage>(
        `/accounts?include_archived=${includeArchived}&limit=${ACCOUNTS_LIST_LIMIT}`,
      ),
  });
}

/** A single account by id, including its live `balance_minor` — disabled
 * (no fetch) while `id` is undefined, so a caller can call this
 * unconditionally before an id is known (e.g. still resolving a route
 * param). */
export function useAccount(id: string | undefined) {
  return useQuery({
    queryKey: qk.account(id ?? ""),
    queryFn: () => apiFetch<AccountOut>(`/accounts/${id}`),
    enabled: id !== undefined,
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAccountPayload) =>
      apiFetch<AccountOut>("/accounts", { method: "POST", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.accounts });
      // An account change (balance, currency) can move an account- or
      // net-worth-sourced goal's progress (`features/goals/useGoals.ts`).
      void queryClient.invalidateQueries({ queryKey: qk.goals });
    },
  });
}

export function useUpdateAccount(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAccountPayload) =>
      apiFetch<AccountOut>(`/accounts/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.accounts });
      // An account change (balance, currency) can move an account- or
      // net-worth-sourced goal's progress (`features/goals/useGoals.ts`).
      void queryClient.invalidateQueries({ queryKey: qk.goals });
    },
  });
}

/** Takes the account id as the mutation's argument (rather than being bound
 * up front like `useUpdateAccount`) since an archive action is typically
 * fired from a list row that already has the id in hand, with no separate
 * per-row hook instance needed. */
export function useArchiveAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/accounts/${id}/archive`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.accounts });
      // An account change (balance, currency) can move an account- or
      // net-worth-sourced goal's progress (`features/goals/useGoals.ts`).
      void queryClient.invalidateQueries({ queryKey: qk.goals });
    },
  });
}
