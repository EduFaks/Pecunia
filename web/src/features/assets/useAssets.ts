/**
 * Query/mutation hooks for the `/assets` resource and its nested
 * `/assets/{id}/valuations` sub-resource. Mirrors `features/accounts/
 * useAccounts.ts`'s shape: every mutation invalidates the single top-level
 * `qk.assets` key (`["assets"]`) rather than naming `qk.asset(id)` or
 * `qk.assetValuations(id)` individually — TanStack Query's partial-match
 * invalidation treats `["assets"]` as a prefix of every nested variant
 * (`["assets", id]`, `["assets", id, "valuations"]`, `["assets", id,
 * "valuations", "chart"]`), so one invalidation refreshes the list, every
 * open asset detail, and every open valuation history/chart in one call.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `AssetType` (`api/src/pecunia/models/asset.py`). */
export type AssetType = "vehicle" | "property" | "investment" | "watch" | "other";

/** Mirrors `AssetOut` (`api/src/pecunia/api/assets.py`). `current_value_minor`
 * is `null` for an asset with no valuations recorded yet. */
export interface AssetOut {
  id: string;
  name: string;
  type: AssetType;
  currency: string;
  acquired_on: string | null;
  current_value_minor: number | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface AssetPage {
  items: AssetOut[];
  next_cursor: string | null;
}

/** Mirrors `AssetIn`. */
export interface CreateAssetPayload {
  name: string;
  type: AssetType;
  currency: string;
  acquired_on?: string | null;
}

/** Mirrors `AssetUpdate` — every field optional, only what changed is sent. */
export interface UpdateAssetPayload {
  name?: string;
  type?: AssetType;
  currency?: string;
  acquired_on?: string | null;
}

/** Mirrors `AssetValuationOut`. */
export interface AssetValuationOut {
  id: string;
  asset_id: string;
  value_minor: number;
  as_of: string;
  source: string | null;
  is_demo: boolean;
  created_at: string;
}

export interface AssetValuationPage {
  items: AssetValuationOut[];
  next_cursor: string | null;
}

/** Mirrors `AssetValuationIn`. */
export interface CreateValuationPayload {
  value_minor: number;
  as_of: string;
  source?: string | null;
}

/** A single asset by id, including its live `current_value_minor` —
 * disabled while `id` is undefined, same pattern as `useAccount`. */
export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: qk.asset(id ?? ""),
    queryFn: () => apiFetch<AssetOut>(`/assets/${id}`),
    enabled: id !== undefined,
  });
}

export function useCreateAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAssetPayload) =>
      apiFetch<AssetOut>("/assets", { method: "POST", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.assets });
    },
  });
}

export function useUpdateAsset(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateAssetPayload) =>
      apiFetch<AssetOut>(`/assets/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.assets });
    },
  });
}

/** Hard delete (`DELETE /assets/{id}` → 204, cascades to its valuations).
 * Takes the asset id as the mutation argument, same shape as
 * `useArchiveAccount`/`useDeleteTransaction`. */
export function useDeleteAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/assets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.assets });
    },
  });
}

/** `POST /assets/{id}/valuations` — recording a new valuation is what moves
 * `current_value_minor` and extends the valuation-history chart, so this
 * invalidates the same `qk.assets` prefix as every other asset mutation. */
export function useAddValuation(assetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateValuationPayload) =>
      apiFetch<AssetValuationOut>(`/assets/${assetId}/valuations`, {
        method: "POST",
        json: payload,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.assets });
    },
  });
}
