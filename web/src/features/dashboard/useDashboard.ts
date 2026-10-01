/**
 * Query/mutation hooks for the dashboard's safe-to-spend hero card (Track U,
 * v1.6): the per-currency "how much can I still spend this month" metric
 * (`GET /analytics/safe-to-spend`) and the optional monthly-budget setting
 * that caps it (`PUT /settings/monthly-budget`). Kept alongside
 * `SafeToSpendCard.tsx` under `features/dashboard/` rather than
 * `features/analytics/useAnalytics.ts` — per the plan this is a
 * dashboard-only concern, not a shared Insights aggregation.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `SafeToSpendOut` (`api/src/pecunia/api/analytics.py`) — one
 * currency's safe-to-spend figures for the current calendar month. Money is
 * integer minor units (§4), never summed across currencies — the endpoint
 * returns a per-currency map and `SafeToSpendCard` picks out the base
 * currency's entry. `limited_by` records whether the optional monthly
 * budget or expected income bound `displayed_safe_minor`. */
export interface SafeToSpend {
  safe_minor: number;
  displayed_safe_minor: number;
  limited_by: "income" | "budget";
  expected_income_minor: number;
  committed_remaining_minor: number;
  spent_mtd_minor: number;
  monthly_budget_minor: number | null;
  days_remaining: number;
  daily_allowance_minor: number;
}

/**
 * The dashboard's safe-to-spend hero metric — one entry per currency with
 * MTD activity or a commitment, the base currency always present (even with
 * nothing happening yet — `SafeToSpendService`'s contract). No reporting
 * window: the endpoint always reads "now", the same bare-slot shape
 * `useSummary`/`useUpcoming` (`features/analytics/useAnalytics.ts`) use.
 */
export function useSafeToSpend() {
  return useQuery({
    queryKey: qk.analytics.safeToSpend(),
    queryFn: () => apiFetch<Record<string, SafeToSpend>>("/analytics/safe-to-spend"),
  });
}

/** Mirrors `MonthlyBudgetOut` (`api/src/pecunia/api/settings.py`). */
export interface MonthlyBudget {
  monthly_budget_minor: number | null;
}

/**
 * Sets (or, passed `null`, clears) the optional monthly budget
 * (`instance_state.settings.monthly_budget_minor`, base-currency only —
 * `SafeToSpendCard`'s inline "definir orçamento" editor is the only caller).
 * On success invalidates every `["analytics"]`-prefixed query — the
 * safe-to-spend figures this directly caps, plus `summary`/`forecast`,
 * which read the same settings row indirectly — and `qk.me`
 * (`usePreferences`'s `/auth/me` cache, which echoes `instance_state.settings`
 * verbatim, see `lib/queries.ts`'s `qk.me` docstring), so a mounted
 * `usePreferences()` consumer also picks up the new value.
 */
export function useSetMonthlyBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (monthlyBudgetMinor: number | null) =>
      apiFetch<MonthlyBudget>("/settings/monthly-budget", {
        method: "PUT",
        json: { monthly_budget_minor: monthlyBudgetMinor },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
      void queryClient.invalidateQueries({ queryKey: qk.me });
    },
  });
}
