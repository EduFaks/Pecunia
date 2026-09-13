/**
 * Query/mutation hooks for the `/subscriptions` resource (the Subscriptions
 * domain, v1.2) plus its `/subscriptions/totals` rollup. A single bounded flat
 * read (`useSubscriptions`) and a per-status totals read
 * (`useSubscriptionTotals`), plus create/update/delete/renew/set-status
 * mutations — the same shape `features/loans/useLoans.ts` uses.
 *
 * A workspace's subscriptions (a handful of recurring services) are a small,
 * user-managed set — like loans/contacts, not an unbounded append-only log —
 * so the list hook reads a generous first page rather than walking a keyset
 * `DataList`. The endpoint is still keyset-paginated server-side by
 * `next_renewal` asc (CONVENTIONS §6); this bounded fetch just consumes the
 * first page, exactly `useLoans`'s rationale. On top of the server's
 * `next_renewal` ordering, the hook's `select` groups active subscriptions
 * ahead of canceled ones (each group still soonest-renewal-first, a stable
 * sort over the already-ordered page) so the screen renders live ones first
 * without a second sort.
 *
 * **Invalidation contract:** every mutation here calls `invalidateSubscriptions`,
 * which invalidates the single top-level `qk.subscriptions` key — a prefix of
 * both this file's `"flat"` list read and its `"totals"` read, so one call
 * refreshes the list AND the monthly/annual rollup header (TanStack's
 * partial-match invalidation, same mechanics as `qk.loans` covering its nested
 * keys). Subscriptions are a *tracker*, not an auto-poster (Planned posts the
 * recurring transactions) — renewing only advances `next_renewal` and creates
 * no transaction — so this deliberately does NOT touch `qk.accounts`,
 * `qk.transactions`, or `["analytics"]`: a subscription change moves none of
 * them.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { qk } from "../../lib/queries";

/** How often a subscription bills. Reuses the shared
 * `weekly|monthly|quarterly|yearly` vocabulary (scheduled/loans use the same
 * set) — mirrors the backend `BillingFrequency` Literal. */
export type BillingFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** A subscription's lifecycle: `active` is live and counted in the totals;
 * `canceled` is kept for history but excluded from the rollup and shown muted.
 * Mirrors `SubscriptionStatus` (`api/src/pecunia/models/subscription.py`). */
export type SubscriptionStatus = "active" | "canceled";

/** Mirrors `SubscriptionOut` (`api/src/pecunia/api/subscriptions.py`).
 * `monthly_minor`/`annual_minor` are the cost normalized to a per-month /
 * per-year figure server-side (integer minor units — weekly ×52/12, monthly
 * ×1, quarterly ÷3, yearly ÷12), so the screen never re-derives them. `logo`
 * is a size-capped `data:image/(png|jpeg|webp);base64,…` data-URI (downscaled
 * client-side by `ImageUpload`), null when unset (the UI renders a monogram
 * fallback via `Avatar`) — the same rule as a contact's `avatar`. */
export interface SubscriptionOut {
  id: string;
  name: string;
  logo: string | null;
  amount_minor: number;
  currency: string;
  billing_frequency: BillingFrequency;
  next_renewal: string;
  started_on: string | null;
  status: SubscriptionStatus;
  contact_id: string | null;
  account_id: string | null;
  category_id: string | null;
  is_demo: boolean;
  created_at: string;
  monthly_minor: number;
  annual_minor: number;
}

export interface SubscriptionPage {
  items: SubscriptionOut[];
  next_cursor: string | null;
}

/** One currency's rollup — Σ of the normalized figures over the subscriptions
 * of the queried status. Mirrors `CurrencyTotal`; money is integer minor units
 * (§4), never summed across currencies. */
export interface CurrencyTotal {
  monthly_minor: number;
  annual_minor: number;
  count: number;
}

/** The per-currency totals envelope `GET /subscriptions/totals` returns —
 * `{currency: {monthly_minor, annual_minor, count}}`, mirroring the
 * `/analytics/*` per-currency shape. The header picks its base currency out of
 * this map client-side. */
export type SubscriptionTotals = Record<string, CurrencyTotal>;

/** Mirrors `SubscriptionIn`. `status` defaults to `active` server-side; the
 * optional link/logo fields are omitted from a create payload when unset. */
export interface CreateSubscriptionPayload {
  name: string;
  amount_minor: number;
  currency: string;
  billing_frequency: BillingFrequency;
  next_renewal: string;
  logo?: string | null;
  started_on?: string | null;
  status?: SubscriptionStatus;
  contact_id?: string | null;
  account_id?: string | null;
  category_id?: string | null;
}

/** Mirrors `SubscriptionUpdate` — every field optional, only what changed is
 * sent (a present `null` clears a link/logo, an absent key leaves it). */
export interface UpdateSubscriptionPayload {
  name?: string;
  amount_minor?: number;
  currency?: string;
  billing_frequency?: BillingFrequency;
  next_renewal?: string;
  status?: SubscriptionStatus;
  logo?: string | null;
  started_on?: string | null;
  contact_id?: string | null;
  account_id?: string | null;
  category_id?: string | null;
}

/** Comfortably covers a personal workspace's full subscription list in one
 * request — same rationale/limit as `useLoans`'s bounded read
 * (`pecunia.pagination.MAX_LIMIT` is 200). */
const LIST_LIMIT = 200;

/** Active subscriptions sort ahead of canceled ones (0 before 1). */
function statusRank(status: SubscriptionStatus): number {
  return status === "active" ? 0 : 1;
}

/**
 * The workspace's subscriptions, each carrying its normalized
 * `monthly_minor`/`annual_minor`. Keyed with a `"flat"` suffix
 * (`[...qk.subscriptions, "flat"]`) — same collision-avoidance move as
 * `useLoans` — so a future keyset read of `qk.subscriptions` never collides
 * with this shape, while every mutation below still invalidates the bare
 * prefix. The `select` reorders the already-`next_renewal`-ordered page so
 * active subscriptions come first (each group still soonest-first), the order
 * `SubscriptionsScreen` renders.
 */
export function useSubscriptions() {
  return useQuery({
    queryKey: [...qk.subscriptions, "flat"],
    queryFn: () => apiFetch<SubscriptionPage>(`/subscriptions?limit=${LIST_LIMIT}`),
    select: (page: SubscriptionPage): SubscriptionPage => ({
      ...page,
      items: [...page.items].sort((a, b) => {
        const byStatus = statusRank(a.status) - statusRank(b.status);
        if (byStatus !== 0) {
          return byStatus;
        }
        return a.next_renewal.localeCompare(b.next_renewal);
      }),
    }),
  });
}

/** The per-currency monthly/annual rollup for the given `status` (active by
 * default — the header's headline spend). Keyed `[...qk.subscriptions,
 * "totals", status]` so it nests under the `qk.subscriptions` prefix every
 * mutation invalidates, and each status is its own cache slot. */
export function useSubscriptionTotals(status: SubscriptionStatus = "active") {
  return useQuery({
    queryKey: [...qk.subscriptions, "totals", status],
    queryFn: () => apiFetch<SubscriptionTotals>(`/subscriptions/totals?status=${status}`),
  });
}

/** Refreshes the subscriptions prefix (the flat list AND the totals rollup —
 * both nest under `qk.subscriptions`). Deliberately nothing else: a
 * subscription is a tracker, so a change never moves an account balance, a
 * transaction, or the analytics series (see this file's header). */
function invalidateSubscriptions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.subscriptions });
}

export function useCreateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSubscriptionPayload) =>
      apiFetch<SubscriptionOut>("/subscriptions", { method: "POST", json: payload }),
    onSuccess: () => invalidateSubscriptions(queryClient),
  });
}

export function useUpdateSubscription(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateSubscriptionPayload) =>
      apiFetch<SubscriptionOut>(`/subscriptions/${id}`, { method: "PATCH", json: payload }),
    onSuccess: () => invalidateSubscriptions(queryClient),
  });
}

/** Hard delete (`DELETE /subscriptions/{id}` → 204). Takes the id as the
 * mutation argument — fired from a list row that already has it in hand. */
export function useDeleteSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/subscriptions/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateSubscriptions(queryClient),
  });
}

/** `POST /subscriptions/{id}/renew` — advances `next_renewal` by one billing
 * cycle. Creates NO transaction (a subscription tracks cost + renewal; Planned
 * remains the thing that posts recurring transactions), so it invalidates only
 * the subscriptions prefix. Takes the id as the mutation argument. */
export function useRenewSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SubscriptionOut>(`/subscriptions/${id}/renew`, { method: "POST" }),
    onSuccess: () => invalidateSubscriptions(queryClient),
  });
}

/** Cancel (`status: "canceled"`) or reactivate (`status: "active"`) via a
 * status-only PATCH. Takes `{ id, status }` since it's fired from a row that
 * already has the id in hand, same shape as `useArchiveContact`. */
export function useSetSubscriptionStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: SubscriptionStatus }) =>
      apiFetch<SubscriptionOut>(`/subscriptions/${id}`, { method: "PATCH", json: { status } }),
    onSuccess: () => invalidateSubscriptions(queryClient),
  });
}
