/**
 * Query hooks for the read-only `/analytics/*` aggregations (Track E). Each
 * endpoint returns a per-currency map (`{currency: [...]}`) — the API never
 * sums figures across currencies (CONVENTIONS §4) — so every hook picks one
 * currency's list out of the response, defaulting to the workspace's base
 * currency (`usePreferences().base_currency`). The full map is what's cached
 * under `qk.analytics.*`; the per-currency selection happens in `select`, so
 * switching the charted currency never triggers a refetch.
 *
 * These are plain (non-paginated) queries — the analytics windows are bounded
 * (last 12 months by default, server-side) — so a keyset `useInfiniteQuery`
 * buys nothing here, same call as `useCategories`/`useContacts`.
 */

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { usePreferences } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import type { AnalyticsRange } from "../../lib/queries";

export type { AnalyticsRange };

/**
 * Shared options for every analytics hook. `currency` picks which currency's
 * list the `select` returns (defaults to the workspace's base currency);
 * `range` is the reporting window — omitted on the dashboard (server defaults
 * to the last 12 months), supplied by the Insights screen's period selector.
 * The range rides in the query key (via `qk.analytics.*`), so changing it is a
 * new cache slot and refetches; `currency` does not, so switching the charted
 * currency stays a client-side `select` with no request.
 */
export interface AnalyticsQueryOptions {
  currency?: string;
  range?: AnalyticsRange;
}

/**
 * Options for the three Insights breakdowns whose endpoints understand the
 * all-time flag (net-worth-composition, spending-by-category,
 * spending-by-contact). `allTime` maps the selector's "All time" mode to
 * `?all=true` — the server extends `from` back to the workspace's earliest
 * activity — and, like `range`, rides in the query key so switching modes
 * refetches. When set it wins outright: no `from`/`to` is sent (an explicit
 * `from` would override `all` server-side).
 */
export interface AllTimeAnalyticsQueryOptions extends AnalyticsQueryOptions {
  allTime?: boolean;
}

/** Appends the `from`/`to` query params for a selected window; a bare path
 * (server-defaulted range) when none is given; `?all=true` alone for the
 * all-time mode (which beats any `range` — see `AllTimeAnalyticsQueryOptions`).
 * Kept here (pure, exported for its unit tests) so every hook builds its URL
 * the same way. */
export function analyticsPath(endpoint: string, range?: AnalyticsRange, allTime?: boolean): string {
  if (allTime) {
    return `/analytics/${endpoint}?all=true`;
  }
  if (!range) {
    return `/analytics/${endpoint}`;
  }
  const params = new URLSearchParams({ from: range.from, to: range.to });
  return `/analytics/${endpoint}?${params.toString()}`;
}

/** Mirrors `CashflowPoint` (`api/src/pecunia/api/analytics.py`). Money is
 * integer minor units (§4); `period_start` is an ISO date (a month start). */
export interface CashflowPoint {
  period_start: string;
  income_minor: number;
  spend_minor: number;
}

/** Mirrors `CategorySpend` — an "Uncategorized" bucket comes back with
 * `category_id: null, color: null`. */
export interface CategorySpend {
  category_id: string | null;
  name: string;
  color: string | null;
  spend_minor: number;
}

/** Mirrors `ContactSpend` — a "No contact" bucket has `contact_id: null`. */
export interface ContactSpend {
  contact_id: string | null;
  name: string;
  spend_minor: number;
}

/** One month-end net-worth value for a currency (reconstructed on read, not persisted). */
export interface NetWorthPoint {
  date: string;
  net_worth_minor: number;
}

/** Mirrors `CompositionPoint` (`api/src/pecunia/api/analytics.py`) — one
 * month-end breakdown of net worth into its four ingredients, each integer
 * minor units (§4). `period_start` is an ISO date (a month start). `debts_minor`
 * is SIGNED — negative for a net liability — so a stacked area places it below
 * the zero axis; the net total is the plain sum of the four. */
export interface CompositionPoint {
  period_start: string;
  cash_minor: number;
  assets_minor: number;
  investments_minor: number;
  debts_minor: number;
}

/** Mirrors `UpcomingDue` (`api/src/pecunia/api/analytics.py`) — one dated item
 * in the horizon. `kind` picks the icon/route; `amount_minor` is signed (and
 * may be null for a loan with no planned payment); `direction` is loan-only
 * (borrowed/lent). `due_on` is an ISO date. */
export interface UpcomingDue {
  kind: "planned" | "subscription" | "loan";
  id: string;
  label: string;
  due_on: string;
  amount_minor: number | null;
  currency: string;
  direction?: string | null;
}

/** Mirrors `OverBudget` — a budget currently over its limit in the active
 * window: `over_minor` is `actual_minor − amount_minor`, `label` the category
 * name. All integer minor units (§4); each row keeps its own currency. */
export interface OverBudget {
  budget_id: string;
  label: string;
  amount_minor: number;
  actual_minor: number;
  over_minor: number;
  currency: string;
}

/** Mirrors `Upcoming` — the two lists the panel renders: `due` is already
 * sorted soonest-first and capped server-side. */
export interface Upcoming {
  due: UpcomingDue[];
  over_budget: OverBudget[];
}

/** The per-currency envelope every analytics endpoint returns. */
export type PerCurrency<T> = Record<string, T[]>;

/**
 * Picks one currency's list out of a per-currency analytics response,
 * defaulting to an empty list when that currency has no data (a currency with
 * no activity is simply absent from the map). Kept pure and exported so the
 * base-currency selection is unit-testable without rendering a hook.
 */
export function selectCurrency<T>(data: PerCurrency<T> | undefined, currency: string): T[] {
  return data?.[currency] ?? [];
}

/** Net-worth-over-time for one currency (base currency by default), oldest
 * point first — reconstructed per month-end on the server from the workspace's
 * dated balances/assets/holdings/loans (nothing persisted), so it matches the
 * composition chart's totals. */
export function useNetWorthSeries({ currency, range }: AnalyticsQueryOptions = {}) {
  const { base_currency } = usePreferences();
  const target = currency ?? base_currency;
  return useQuery({
    queryKey: qk.analytics.netWorth(range),
    queryFn: () => apiFetch<PerCurrency<NetWorthPoint>>(analyticsPath("net-worth", range)),
    select: (data) => selectCurrency(data, target),
  });
}

/** Monthly net-worth composition (cash / assets / investments / signed debts)
 * for one currency (base currency by default), oldest month first — the source
 * of the Insights stacked-area chart. Driven by the Insights period selector,
 * so the window (a `range`, or the all-time mode) rides in the query key and
 * switching refetches. */
export function useNetWorthComposition({
  currency,
  range,
  allTime,
}: AllTimeAnalyticsQueryOptions = {}) {
  const { base_currency } = usePreferences();
  const target = currency ?? base_currency;
  return useQuery({
    queryKey: qk.analytics.netWorthComposition(range, allTime),
    queryFn: () =>
      apiFetch<PerCurrency<CompositionPoint>>(
        analyticsPath("net-worth-composition", range, allTime),
      ),
    select: (data) => selectCurrency(data, target),
  });
}

/** Monthly income vs. spend for one currency (base currency by default),
 * oldest month first, every month in range present. */
export function useCashflow({ currency, range }: AnalyticsQueryOptions = {}) {
  const { base_currency } = usePreferences();
  const target = currency ?? base_currency;
  return useQuery({
    queryKey: qk.analytics.cashflow(range),
    queryFn: () => apiFetch<PerCurrency<CashflowPoint>>(analyticsPath("cashflow", range)),
    select: (data) => selectCurrency(data, target),
  });
}

/** Expense magnitude by category for one currency (base currency by default),
 * sorted by spend descending, with an "Uncategorized" bucket. Takes the
 * Insights selector's window — a bounded `range`, or `allTime` (`?all=true`). */
export function useSpendingByCategory({
  currency,
  range,
  allTime,
}: AllTimeAnalyticsQueryOptions = {}) {
  const { base_currency } = usePreferences();
  const target = currency ?? base_currency;
  return useQuery({
    queryKey: qk.analytics.spendingByCategory(range, allTime),
    queryFn: () =>
      apiFetch<PerCurrency<CategorySpend>>(analyticsPath("spending-by-category", range, allTime)),
    select: (data) => selectCurrency(data, target),
  });
}

/** Expense magnitude by contact for one currency (base currency by default),
 * sorted by spend descending, with a "No contact" bucket (`contact_id: null`).
 * Mirrors `useSpendingByCategory` against `/analytics/spending-by-contact`. */
export function useSpendingByContact({
  currency,
  range,
  allTime,
}: AllTimeAnalyticsQueryOptions = {}) {
  const { base_currency } = usePreferences();
  const target = currency ?? base_currency;
  return useQuery({
    queryKey: qk.analytics.spendingByContact(range, allTime),
    queryFn: () =>
      apiFetch<PerCurrency<ContactSpend>>(analyticsPath("spending-by-contact", range, allTime)),
    select: (data) => selectCurrency(data, target),
  });
}

/**
 * What's coming on the dashboard — the soonest planned/subscription/loan items
 * due (next 30 days, server-defaulted) plus any budgets currently over. Unlike
 * the charts above this is not a per-currency map and takes no reporting range:
 * each item carries its own currency (never summed, §4), so it's a plain query
 * returning the `{ due, over_budget }` object as-is (`due` already sorted
 * soonest-first and capped server-side).
 */
export function useUpcoming() {
  return useQuery({
    queryKey: qk.analytics.upcoming(),
    queryFn: () => apiFetch<Upcoming>("/analytics/upcoming"),
  });
}
