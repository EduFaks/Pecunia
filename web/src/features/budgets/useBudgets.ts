/**
 * Mutation hooks for the `/budgets` resource. `BudgetsScreen` reads the
 * list through `DataList` directly (a keyset-paginated GET has no useful
 * non-paginated hook shape to share — same rationale as `features/
 * transactions/useTransactions.ts`'s docstring), so this file only carries
 * the writes: create/update/delete. Every mutation invalidates the single
 * top-level `qk.budgets` key.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `BudgetPeriod` (`api/src/pecunia/models/budget.py`). */
export type BudgetPeriod = "weekly" | "monthly" | "quarterly" | "yearly";

/** Mirrors `BudgetOut` (`api/src/pecunia/api/budgets.py`). `actual_minor`/
 * `remaining_minor` are computed server-side (summed spend for the current
 * period against `category_id`) and are `null` together whenever a budget
 * has no category — there's nothing to sum. `BudgetVsActualBar` renders
 * accordingly. */
export interface BudgetOut {
  id: string;
  name: string;
  category_id: string | null;
  period: BudgetPeriod;
  amount_minor: number;
  currency: string;
  actual_minor: number | null;
  remaining_minor: number | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface BudgetPage {
  items: BudgetOut[];
  next_cursor: string | null;
}

/** Mirrors `BudgetIn`. */
export interface CreateBudgetPayload {
  name: string;
  category_id?: string | null;
  period: BudgetPeriod;
  amount_minor: number;
  currency: string;
}

/** Mirrors `BudgetUpdate` — every field optional, only what changed is sent. */
export interface UpdateBudgetPayload {
  name?: string;
  category_id?: string | null;
  period?: BudgetPeriod;
  amount_minor?: number;
  currency?: string;
}

export function useCreateBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateBudgetPayload) =>
      apiFetch<BudgetOut>("/budgets", { method: "POST", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.budgets });
    },
  });
}

export function useUpdateBudget(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateBudgetPayload) =>
      apiFetch<BudgetOut>(`/budgets/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.budgets });
    },
  });
}

/** Hard delete (`DELETE /budgets/{id}` → 204). Takes the budget id as the
 * mutation argument, same shape as `useDeleteAsset`/`useDeleteProject`. */
export function useDeleteBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/budgets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.budgets });
    },
  });
}
