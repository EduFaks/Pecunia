/**
 * Query/mutation hooks for the `/transfers` resource — the sibling of
 * `features/contacts/useContacts.ts` (flat list) and
 * `features/transactions/useTransactions.ts` (write mutations).
 *
 * A transfer is a first-class object that owns two transaction legs (a
 * `-amount` outflow on the source account and a `+amount` inflow on the
 * destination), so **every** mutation here invalidates three prefixes:
 *   - `qk.transfers` — the transfers list itself (and the id→transfer map the
 *     transaction screens build from it to label legs).
 *   - `qk.transactions()` — the unscoped key, a prefix of every account-scoped
 *     variant, so both legs appear/disappear/relabel in every open list.
 *   - `qk.accounts` — a transfer moves both account balances; this prefix also
 *     covers every `qk.account(id)` detail query and the Dashboard's
 *     `[...qk.accounts, "dashboard"]` balance/net-worth reads (net worth is
 *     unchanged since the legs net to zero, but the per-account balances that
 *     feed it both move). Same balance-reactivity contract the transaction
 *     mutations follow.
 *
 * The list read mirrors `useContacts`: a workspace's transfers are a small,
 * user-managed set, so a bounded flat first page (keyed with a `"flat"`
 * suffix, same collision-avoidance rationale as the other flat hooks) is all
 * the leg-labeling maps need. The endpoint still supports keyset paging
 * (`TransferPage.next_cursor`); this just reads a generous first page.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `TransferOut` (`api/src/pecunia/api/transfers.py`). `amount_minor`
 * is a positive magnitude in the shared `currency`; the sign lives on the two
 * legs, not here. */
export interface TransferOut {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount_minor: number;
  currency: string;
  description: string;
  occurred_on: string;
  is_demo: boolean;
  created_at: string;
}

export interface TransferPage {
  items: TransferOut[];
  next_cursor: string | null;
}

/** Mirrors `TransferIn` — `currency` is the shared currency of both accounts
 * (the server rejects a cross-currency transfer). */
export interface CreateTransferPayload {
  from_account_id: string;
  to_account_id: string;
  amount_minor: number;
  currency: string;
  description: string;
  occurred_on: string;
}

/** Mirrors `TransferUpdate` — every field optional, only what changed is sent.
 * No `currency`: the server re-derives it from the (possibly changed)
 * accounts, so the client never sends it on an edit. */
export interface UpdateTransferPayload {
  from_account_id?: string;
  to_account_id?: string;
  amount_minor?: number;
  description?: string;
  occurred_on?: string;
}

/** Comfortably covers a personal workspace's full transfer list in one
 * request — same rationale/limit as `useContacts`'s `CONTACTS_LIST_LIMIT`. */
const TRANSFERS_LIST_LIMIT = 200;

/** The flat (non-paginated) transfers list — powers the id→transfer map the
 * transaction screens use to label a leg's counterpart account. */
export function useTransfers() {
  return useQuery({
    queryKey: [...qk.transfers, "flat"],
    queryFn: () => apiFetch<TransferPage>(`/transfers?limit=${TRANSFERS_LIST_LIMIT}`),
  });
}

function invalidateAfterTransfer(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.transfers });
  void queryClient.invalidateQueries({ queryKey: qk.transactions() });
  void queryClient.invalidateQueries({ queryKey: qk.accounts });
}

export function useCreateTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateTransferPayload) =>
      apiFetch<TransferOut>("/transfers", { method: "POST", json: payload }),
    onSuccess: () => invalidateAfterTransfer(queryClient),
  });
}

export function useUpdateTransfer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTransferPayload) =>
      apiFetch<TransferOut>(`/transfers/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => invalidateAfterTransfer(queryClient),
  });
}

/** Hard delete (`DELETE /transfers/{id}` → 204) — removes the transfer and,
 * via server-side CASCADE, both of its legs. Takes the id as the mutation
 * argument, same shape as `useDeleteTransaction`. There is no restore
 * endpoint for a transfer (unlike a soft-deleted transaction). */
export function useDeleteTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/transfers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateAfterTransfer(queryClient),
  });
}
