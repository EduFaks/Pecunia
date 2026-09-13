/**
 * Query/mutation hooks for the `/goals` resource (the Goals domain, v1.4). A
 * single bounded flat read (`useGoals`) plus create/update/delete mutations
 * — the same shape `features/contacts/useContacts.ts` uses. A workspace's
 * savings goals are a small, user-managed set, not an unbounded/append-only
 * log, so a keyset-paginated `DataList` buys nothing here; the endpoint is
 * still keyset-paginated server-side (CONVENTIONS §6), this bounded fetch
 * just reads a generous first page.
 *
 * A goal's `progress`/`eta` are computed server-side on every read (derived
 * from its source — an account balance, a portfolio value, net worth, or a
 * manual figure — never stored), so `GoalOut` already carries the figures
 * `GoalRing` needs; there is no separate progress/eta hook, and no OTHER
 * mutation anywhere needs to invalidate `qk.goals` — a goal's numbers move
 * because its underlying source moved, and the next read simply recomputes
 * them fresh (nothing cached to go stale).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** Mirrors `GoalSourceKind` (`api/src/pecunia/models/goal.py`) — where a
 * goal's `progress`/`eta` read their current value from. */
export type GoalSourceKind = "account" | "portfolio" | "net_worth" | "manual";

/** Mirrors `GoalProgress` (`api/src/pecunia/api/goals.py`). `pct_bps` is
 * basis points (10_000 = 100%), unclamped — a goal past its target reports
 * more than 10_000; `GoalRing` clamps the visual fill itself. */
export interface GoalProgress {
  current_minor: number;
  target_minor: number;
  pct_bps: number;
}

/** Mirrors `GoalEta`. `reached_on` is the month-end `ForecastService`
 * projects this goal reaching its target by (or today, if already reached);
 * `null` when it doesn't reach the target within the forecast's 6-month
 * horizon (`on_track: false`). */
export interface GoalEta {
  reached_on: string | null;
  on_track: boolean;
}

/** Mirrors `GoalOut`. `source_id` is the referenced account/portfolio id for
 * the `account`/`portfolio` kinds, always `null` otherwise;
 * `manual_current_minor` is only ever set for `manual`. */
export interface GoalOut {
  id: string;
  name: string;
  target_minor: number;
  currency: string;
  target_date: string | null;
  source_kind: GoalSourceKind;
  source_id: string | null;
  manual_current_minor: number | null;
  created_at: string;
  progress: GoalProgress;
  eta: GoalEta;
}

export interface GoalPage {
  items: GoalOut[];
  next_cursor: string | null;
}

/** Mirrors `GoalIn`. `source_kind` defaults to `manual` server-side, but the
 * form always sends one explicitly. */
export interface CreateGoalPayload {
  name: string;
  target_minor: number;
  currency: string;
  target_date?: string | null;
  source_kind?: GoalSourceKind;
  source_id?: string | null;
  manual_current_minor?: number | null;
}

/** Mirrors `GoalUpdate` — every field optional, only what changed is sent. */
export interface UpdateGoalPayload {
  name?: string;
  target_minor?: number;
  currency?: string;
  target_date?: string | null;
  source_kind?: GoalSourceKind;
  source_id?: string | null;
  manual_current_minor?: number | null;
}

/** Comfortably covers a personal workspace's full goal list in one request —
 * same rationale/limit as `useContacts`'s `CONTACTS_LIST_LIMIT`. */
const GOALS_LIST_LIMIT = 200;

/** The flat (non-paginated) goal list, each carrying its live `progress`/
 * `eta`. Keyed with a `"flat"` suffix (`[...qk.goals, "flat"]`) — same
 * collision-avoidance move as `useContacts`/`useLoans` — so a future keyset
 * read of `qk.goals` never collides with this shape, while every mutation
 * below still invalidates the bare prefix. Powers `GoalsScreen` and the
 * Dashboard's goals summary widget. */
export function useGoals() {
  return useQuery({
    queryKey: [...qk.goals, "flat"],
    queryFn: () => apiFetch<GoalPage>(`/goals?limit=${GOALS_LIST_LIMIT}`),
  });
}

/** A single goal by id, including its live `progress`/`eta` — disabled
 * while `id` is undefined, same pattern as `useContact`/`useLoan`. */
export function useGoal(id: string | undefined) {
  return useQuery({
    queryKey: [...qk.goals, id ?? ""],
    queryFn: () => apiFetch<GoalOut>(`/goals/${id}`),
    enabled: id !== undefined,
  });
}

function invalidateGoals(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.goals });
}

export function useCreateGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateGoalPayload) =>
      apiFetch<GoalOut>("/goals", { method: "POST", json: payload }),
    onSuccess: () => invalidateGoals(queryClient),
  });
}

export function useUpdateGoal(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateGoalPayload) =>
      apiFetch<GoalOut>(`/goals/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => invalidateGoals(queryClient),
  });
}

/** Hard delete (`DELETE /goals/{id}` → 204). Takes the goal id as the
 * mutation argument, same shape as `useDeleteLoan`. */
export function useDeleteGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/goals/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateGoals(queryClient),
  });
}
