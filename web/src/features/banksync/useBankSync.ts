/**
 * Query/mutation hooks for the `/bank-sync` resource (Track T). Provides
 * connections list, discovery, link management, reconciliation, sync triggers,
 * and category mappings. A workspace's bank connections are a small, actively
 * managed set, not an unbounded log, so a bounded flat read buys everything
 * here; the endpoints are keyset-paginated server-side (CONVENTIONS §6), this
 * bounded fetch just reads a generous first page.
 *
 * Link/sync/reconcile mutations invalidate `qk.bankSync` + `qk.accounts` +
 * `qk.transactions()` + `["analytics"]` (they alter account balances/
 * transaction history). Unlink/delete/mappings mutations invalidate only
 * `qk.bankSync` — see invalidation helpers below.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `BankLinkOut` (`api/src/pecunia/api/bank_sync.py`). Represents
 * a single Pluggy account linked to a Pecunia account within a connection. */
export interface BankLinkOut {
  id: string;
  account_id: string;
  account_name: string;
  account_currency: string;
  pluggy_account_id: string;
  sync_from: string;
  provider_balance_minor: number;
  provider_balance_as_of: string | null;
  derived_balance_minor: number;
  credit_limit_minor: number | null;
  bill_close_date: string | null;
  bill_due_date: string | null;
}

/** Mirrors `BankConnectionOut`. Represents a single connection to a bank
 * (via Pluggy) and its linked accounts. */
export interface BankConnectionOut {
  id: string;
  status: "ok" | "error";
  last_error: string | null;
  last_synced_at: string | null;
  links: BankLinkOut[];
}

/** Mirrors `DiscoveredAccountOut`. Represents a Pluggy account discovered
 * during the link wizard, potentially already linked to a Pecunia account. */
export interface DiscoveredAccountOut {
  pluggy_item_id: string;
  pluggy_account_id: string;
  type: "BANK" | "CREDIT";
  balance: number;
  linked_account_id: string | null;
}

/** Mirrors `CategoryMappingOut`. A mapping from a Pluggy transaction
 * category to a Pecunia category. */
export interface CategoryMappingOut {
  pluggy_category: string;
  category_id: string;
}

/** Mirrors `SyncResultOut`. Summary of a sync operation. */
export interface SyncResultOut {
  connections: number;
  created: number;
  skipped: number;
  errors: string[];
}

/** Mirrors `TransactionOut`. A reconciliation produces a transaction. */
export interface TransactionOut {
  id: string;
  account_id: string;
  description: string;
  amount_minor: number;
  currency: string;
  date: string;
  type: string;
  category_id: string | null;
  contact_id: string | null;
  is_demo: boolean;
  created_at: string;
}

/** Mirrors `LinkPayloadIn` — the request body for POST /bank-sync/links. */
export interface LinkPayload {
  pluggy_item_id: string;
  pluggy_account_id: string;
  sync_from: string;
  account_id?: string;
  new_account?: {
    name: string;
    currency: string;
  };
}

/** Mirrors `CreateAccountPayload`. Used when creating a new account during
 * the link wizard. */
export interface CreateAccountPayload {
  name: string;
  currency: string;
}

/** Comfortably covers a personal workspace's full connections list in one
 * request — same rationale as `useGoals`'s `GOALS_LIST_LIMIT`. */
const CONNECTIONS_LIST_LIMIT = 200;

/** The flat (non-paginated) connections list with all linked accounts and
 * their current sync status. Keyed with the bare `qk.bankSync` — no suffix
 * since this IS the primary shape, unlike `useGoals`'s `"flat"` suffix
 * (goals have a keyset-paginated detail shape that'd collide). Powers
 * `ConnectionsPanel` and any dashboard summary. */
export function useBankConnections() {
  return useQuery({
    queryKey: qk.bankSync,
    queryFn: () => apiFetch<BankConnectionOut[]>(`/bank-sync/connections?limit=${CONNECTIONS_LIST_LIMIT}`),
  });
}

/** Discovered accounts from Pluggy, filtered to those not yet linked. Takes
 * optional callback to dismiss the query gracefully when discovery is
 * unavailable (503). Returns empty array on error unless a callback catches
 * it. */
export function useBankDiscovery(onUnavailable?: () => void) {
  return useQuery({
    queryKey: [...qk.bankSync, "discovery"],
    queryFn: async () => {
      try {
        return await apiFetch<DiscoveredAccountOut[]>("/bank-sync/discovery");
      } catch (err) {
        const error = err as { status?: number };
        if (error.status === 503) {
          onUnavailable?.();
          return [];
        }
        throw err;
      }
    },
  });
}

function invalidateBankSync(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.bankSync });
}

function invalidateBankSyncAndBalances(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.bankSync });
  void queryClient.invalidateQueries({ queryKey: qk.accounts });
  void queryClient.invalidateQueries({ queryKey: qk.transactions() });
  void queryClient.invalidateQueries({ queryKey: ["analytics"] });
}

/** Link a discovered Pluggy account to an existing or new Pecunia account.
 * Invalidates bankSync + accounts + transactions + analytics (balance impact). */
export function useLinkAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LinkPayload) =>
      apiFetch<BankConnectionOut>("/bank-sync/links", { method: "POST", json: payload }),
    onSuccess: () => invalidateBankSyncAndBalances(queryClient),
  });
}

/** Unlink a single Pluggy account from its Pecunia account without deleting
 * the connection. Invalidates bankSync only (no balance change). */
export function useUnlinkAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) =>
      apiFetch<void>(`/bank-sync/links/${linkId}`, { method: "DELETE" }),
    onSuccess: () => invalidateBankSync(queryClient),
  });
}

/** Delete an entire connection (all its links) in one shot. Invalidates
 * bankSync only (unlink, no fetch of new data). */
export function useDeleteConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      apiFetch<void>(`/bank-sync/connections/${connectionId}`, { method: "DELETE" }),
    onSuccess: () => invalidateBankSync(queryClient),
  });
}

/** Fetch new transactions from all connected banks and post them to linked
 * accounts. Returns a summary of synced connections/transactions. Invalidates
 * bankSync + accounts + transactions + analytics (new transaction data). */
export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SyncResultOut>("/bank-sync/sync", { method: "POST" }),
    onSuccess: () => invalidateBankSyncAndBalances(queryClient),
  });
}

/** Reconcile a linked account (post a single balancing transaction to
 * eliminate divergence between provider and derived balance). Invalidates
 * bankSync + accounts + transactions + analytics (new transaction). */
export function useReconcile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) =>
      apiFetch<TransactionOut>(`/bank-sync/links/${linkId}/reconcile`, { method: "POST" }),
    onSuccess: () => invalidateBankSyncAndBalances(queryClient),
  });
}

/** Fetch all Pluggy → Pecunia category mappings. */
export function useCategoryMappings() {
  return useQuery({
    queryKey: [...qk.bankSync, "category-mappings"],
    queryFn: () => apiFetch<CategoryMappingOut[]>("/bank-sync/category-mappings"),
  });
}

/** Update all Pluggy → Pecunia category mappings. Invalidates bankSync only
 * (category changes don't affect live balance data). */
export function useReplaceMappings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mappings: CategoryMappingOut[]) =>
      apiFetch<CategoryMappingOut[]>("/bank-sync/category-mappings", {
        method: "PUT",
        json: { mappings },
      }),
    onSuccess: () => invalidateBankSync(queryClient),
  });
}
