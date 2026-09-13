/**
 * Query/mutation hooks for the `/planned` resource — the Planned domain's
 * recurring schedules (v1.1). A single bounded flat read (`usePlanned`) plus
 * create/update/post/skip/delete mutations, the same shape
 * `features/contacts/useContacts.ts` and `features/projects/useProjects.ts` use.
 *
 * A workspace's schedules are a small, user-managed set (salary, rent, a few
 * subscriptions) — like contacts/projects, not an unbounded/append-only log like
 * transactions — so `usePlanned` reads a generous first page rather than
 * walking a keyset `DataList`. The endpoint is still keyset-paginated server-
 * side (soonest-first, `next_due ASC` — CONVENTIONS §6); this bounded fetch
 * just consumes that first page, exactly `useContacts`'s rationale.
 *
 * **Invalidation contract:**
 *   - create/update/delete and the pause/resume toggle only touch the schedule
 *     itself → invalidate `qk.planned`.
 *   - **post and skip** also refresh the finance surfaces (`qk.transactions()`,
 *     `qk.accounts`, `["analytics"]`): posting creates a real `Transaction`
 *     that moves balances and analytics, so every visible balance/list/figure
 *     must re-read. Skip advances `next_due` without creating a transaction,
 *     but shares the same broad invalidation so a schedule action never leaves
 *     a stale finance view (the extra refetches are harmless — the plan keeps
 *     the two symmetric).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";
import type { TransactionOut } from "../transactions/useTransactions";

/** Mirrors `ScheduleFrequency` (`api/src/pecunia/models/scheduled_transaction.py`). */
export type ScheduleFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** Mirrors `ScheduledTransactionOut` (`api/src/pecunia/api/scheduled_transactions.py`).
 * `amount_minor` is signed, same convention as a transaction: negative =
 * expense, positive = income. */
export interface ScheduledTransactionOut {
  id: string;
  account_id: string;
  category_id: string | null;
  contact_id: string | null;
  amount_minor: number;
  currency: string;
  description: string;
  frequency: ScheduleFrequency;
  interval_count: number;
  next_due: string;
  end_date: string | null;
  is_active: boolean;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
}

export interface SchedulePage {
  items: ScheduledTransactionOut[];
  next_cursor: string | null;
}

/** `POST /planned/{id}/post`'s body: the advanced schedule plus the real
 * transaction it created. */
export interface PostResult {
  schedule: ScheduledTransactionOut;
  transaction: TransactionOut;
}

/** Mirrors `ScheduleIn`. */
export interface CreateSchedulePayload {
  account_id: string;
  category_id?: string | null;
  contact_id?: string | null;
  amount_minor: number;
  currency: string;
  description: string;
  frequency: ScheduleFrequency;
  interval_count?: number;
  next_due: string;
  end_date?: string | null;
}

/** Mirrors `ScheduleUpdate` — every field optional, only what changed is sent.
 * `is_active` is the pause/resume toggle (the router routes it to
 * `set_active`). */
export interface UpdateSchedulePayload {
  account_id?: string;
  category_id?: string | null;
  contact_id?: string | null;
  amount_minor?: number;
  currency?: string;
  description?: string;
  frequency?: ScheduleFrequency;
  interval_count?: number;
  next_due?: string;
  end_date?: string | null;
  is_active?: boolean;
}

/** Comfortably covers a personal workspace's full schedule list in one
 * request — same rationale/limit as `useContacts`'s bounded read. */
const PLANNED_LIST_LIMIT = 200;

/**
 * The workspace's schedules, active-first. The server returns them soonest-
 * first (`next_due ASC`); a stable client sort lifts active schedules above
 * paused ones while preserving that soonest-first order within each group — so
 * the things that will actually post appear first, with paused schedules (kept
 * in the list, marked with a paused indicator) trailing. Keyed with a `"flat"`
 * suffix so it never collides with any future keyset read of `qk.planned`,
 * while every mutation below still invalidates the bare prefix.
 */
export function usePlanned() {
  return useQuery({
    queryKey: [...qk.planned, "flat"],
    queryFn: () => apiFetch<SchedulePage>(`/planned?limit=${PLANNED_LIST_LIMIT}`),
    select: (page) => ({
      ...page,
      items: [...page.items].sort((a, b) => Number(b.is_active) - Number(a.is_active)),
    }),
  });
}

function invalidatePlanned(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.planned });
}

/** post/skip: a schedule action that moves (post) — or is treated as if it
 * moves (skip) — the finance surfaces, so refresh schedules, transactions,
 * balances, and analytics together. `["analytics"]` is the shared analytics
 * prefix documented in `lib/queries.ts` (`qk.analytics.*` all nest under it),
 * so one call covers every analytics window. */
function invalidateAfterPostOrSkip(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.planned });
  void queryClient.invalidateQueries({ queryKey: qk.transactions() });
  void queryClient.invalidateQueries({ queryKey: qk.accounts });
  void queryClient.invalidateQueries({ queryKey: ["analytics"] });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSchedulePayload) =>
      apiFetch<ScheduledTransactionOut>("/planned", { method: "POST", json: payload }),
    onSuccess: () => invalidatePlanned(queryClient),
  });
}

export function useUpdateSchedule(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateSchedulePayload) =>
      apiFetch<ScheduledTransactionOut>(`/planned/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => invalidatePlanned(queryClient),
  });
}

/** `POST /planned/{id}/post` → 201 `{schedule, transaction}`. Takes the
 * schedule id as the mutation argument — fired from a list row that already
 * has the id in hand (same shape as `useDeleteTransaction`). */
export function usePostSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PostResult>(`/planned/${id}/post`, { method: "POST" }),
    onSuccess: () => invalidateAfterPostOrSkip(queryClient),
  });
}

/** `POST /planned/{id}/skip` → the advanced schedule (no transaction created). */
export function useSkipSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ScheduledTransactionOut>(`/planned/${id}/skip`, { method: "POST" }),
    onSuccess: () => invalidateAfterPostOrSkip(queryClient),
  });
}

/** Hard delete (`DELETE /planned/{id}` → 204) — permanent, so the caller
 * gates it behind a `ConfirmDialog`. Takes the schedule id as the mutation
 * argument. */
export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/planned/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidatePlanned(queryClient),
  });
}
