/**
 * Query/mutation hooks for the `/categories` resource. Mirrors
 * `features/accounts/useAccounts.ts`'s shape: a flat (non-paginated) query
 * hook plus create/update/archive mutations, all invalidating the single
 * `qk.categories` prefix.
 *
 * The flat hook is deliberately the *only* read path this file exports —
 * unlike accounts/transactions/budgets, there is no separate keyset-
 * paginated `DataList` for categories. A workspace's categories are a
 * small, bounded, user-managed set (the ~11 seeded defaults plus whatever a
 * person adds), not an unbounded/append-only list like transactions or the
 * audit log — and `CategoriesPanel`'s "grouped by kind" requirement can't
 * be satisfied by a keyset walk anyway (`GET /categories` orders by
 * `created_at`, with no `kind` filter to page one group at a time). So both
 * `CategoryPicker` (a picker dropdown) and `CategoriesPanel` (the Settings
 * management screen) read the same bounded flat list and group it
 * client-side, the same way `TransactionForm`'s account `Select` reads
 * `useAccounts()` rather than walking `AccountsScreen`'s own `DataList`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import type { CategoryKind } from "./categoryTypes";

/** Mirrors `CategoryOut` (`api/src/pecunia/api/categories.py`). Note there's
 * no `created_at`/`updated_at` here — the backend's `CategoryOut` schema
 * doesn't serialize them (unlike accounts/transactions/budgets). */
export interface CategoryOut {
  id: string;
  name: string;
  kind: CategoryKind;
  color: string;
  icon: string | null;
  archived_at: string | null;
  is_demo: boolean;
}

export interface CategoryPage {
  items: CategoryOut[];
  next_cursor: string | null;
}

/** Mirrors `CategoryIn`. */
export interface CreateCategoryPayload {
  name: string;
  kind: CategoryKind;
  color: string;
  icon?: string | null;
}

/** Mirrors `CategoryUpdate` — every field optional, only what changed is sent. */
export interface UpdateCategoryPayload {
  name?: string;
  kind?: CategoryKind;
  color?: string;
  icon?: string | null;
}

/** Comfortably covers a personal workspace's full category list in one
 * request — same rationale/limit as `useAccounts.ts`'s `ACCOUNTS_LIST_LIMIT`. */
const CATEGORIES_LIST_LIMIT = 200;

/** The flat (non-paginated) category list, `include_archived` defaulting to
 * `false` — powers `CategoryPicker` (active categories to choose from,
 * `true` when the picker's current value is itself archived — see that
 * component) and `CategoriesPanel` (its own "Show archived" toggle passes
 * this straight through).
 *
 * Keyed with a `"flat"` suffix (`[...qk.categories, "flat", {includeArchived}]`)
 * — same collision-avoidance rationale as `useAccounts.ts`'s flat hook —
 * so a caller that also happens to read `qk.categories` some other way (none
 * exist yet, but the mutations below invalidate the bare prefix) never
 * collides with this shape. */
export function useCategories(includeArchived = false) {
  return useQuery({
    queryKey: [...qk.categories, "flat", { includeArchived }],
    queryFn: () =>
      apiFetch<CategoryPage>(
        `/categories?include_archived=${includeArchived}&limit=${CATEGORIES_LIST_LIMIT}`,
      ),
  });
}

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateCategoryPayload) =>
      apiFetch<CategoryOut>("/categories", { method: "POST", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.categories });
    },
  });
}

export function useUpdateCategory(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateCategoryPayload) =>
      apiFetch<CategoryOut>(`/categories/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.categories });
    },
  });
}

/** Takes the category id as the mutation's argument, same shape as
 * `useArchiveAccount` — fired from a management-panel row that already has
 * the id in hand. */
export function useArchiveCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/categories/${id}/archive`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.categories });
    },
  });
}
