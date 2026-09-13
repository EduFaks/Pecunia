/**
 * Query-key factory shared by every feature that reads server state, so
 * "what key does the accounts list live under" has exactly one answer
 * instead of each screen inventing its own array. Keys are hierarchical
 * (`["accounts", id]` nests under `["accounts"]`) so an
 * `invalidateQueries({ queryKey: qk.accounts })` — TanStack Query's default
 * partial-match semantics — also invalidates any detail query for that
 * resource, without having to enumerate every id in flight.
 *
 * `me` is deliberately its own top-level key: `lib/auth.tsx`'s
 * `AuthProvider` fetches `/auth/me` itself during the boot sequence, but
 * does so with a plain `apiFetch` call, not through TanStack Query (see its
 * SECURITY-CRITICAL header in CONVENTIONS §9.5 — not a module to restructure
 * casually for this). `lib/preferences.tsx`'s `usePreferences` is the first
 * (and, for now, only) consumer of this key; it fetches `/auth/me` again
 * under `qk.me`, so if anything else ever seeds this same key (e.g. via
 * `queryClient.setQueryData`), `usePreferences` picks it up for free.
 */

export interface AuditEventFilters {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  since?: string;
  until?: string;
}

/** An inclusive reporting window for the `/analytics/*` endpoints — both ISO
 * date strings (`YYYY-MM-DD`). Omitted entirely for the dashboard's default
 * view (the server defaults to the last 12 months); supplied by the Insights
 * screen's period selector. */
export interface AnalyticsRange {
  from: string;
  to: string;
}

/** Builds one analytics endpoint's query key: the bare `["analytics",
 * <endpoint>]` prefix when no window is selected (identical to the pre-Task-4
 * key, so the dashboard's cache slot is unchanged), or that prefix plus the
 * `{ from, to }` object when a period is chosen — a distinct slot per window
 * that still falls under the shared prefix for invalidation. The all-time
 * mode (`allTime`, the Insights "All time" option → `?all=true`) gets its own
 * `"all"` slot on the same footing: a distinct cache entry, so switching to
 * it refetches, still covered by the `["analytics"]` prefix. */
function analyticsKey(endpoint: string, range?: AnalyticsRange, allTime?: boolean) {
  if (allTime) {
    return ["analytics", endpoint, "all"] as const;
  }
  return range ? (["analytics", endpoint, range] as const) : (["analytics", endpoint] as const);
}

export const qk = {
  me: ["me"] as const,

  accounts: ["accounts"] as const,
  account: (id: string) => ["accounts", id] as const,

  /** Unscoped (`["transactions"]`) when no `accountId` is given — still a
   * prefix of every scoped variant below, so invalidating `qk.transactions()`
   * with no argument covers all of them. */
  transactions: (accountId?: string) =>
    accountId ? (["transactions", { accountId }] as const) : (["transactions"] as const),

  assets: ["assets"] as const,
  asset: (id: string) => ["assets", id] as const,
  /** An asset's valuation history — nested under `qk.asset(id)` so
   * invalidating that (2-element) key also covers this (3-element) one via
   * TanStack Query's prefix-match invalidation, same mechanics as every
   * other nested key here. `AssetDetail`'s bounded chart fetch further
   * suffixes this with `"chart"` to keep it a distinct cache entry from the
   * paginated valuation-history `DataList`, which reads this key directly —
   * both still fall under the same `qk.asset(id)` invalidation. */
  assetValuations: (assetId: string) => ["assets", assetId, "valuations"] as const,

  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  /** A project's line items — same nesting rationale as `assetValuations`. */
  projectItems: (projectId: string) => ["projects", projectId, "items"] as const,

  budgets: ["budgets"] as const,

  /** Investment portfolios (the Portfolio domain, v1.1). A portfolio's
   * holdings nest under it — `qk.holdings(id)` is `["portfolios", id,
   * "holdings"]` — so invalidating the bare `qk.portfolios` prefix refreshes
   * the portfolio list, every open portfolio detail, AND every open holdings
   * list in one call (TanStack's partial-match invalidation), the exact
   * mechanics `qk.assets`/`qk.assetValuations` use. `usePortfolios`/
   * `useHoldings` suffix their bounded flat reads (`"flat"`) so they never
   * collide with a future keyset walk of the same prefix, while every
   * mutation still invalidates the bare prefix. */
  portfolios: ["portfolios"] as const,
  portfolio: (id: string) => ["portfolios", id] as const,
  holdings: (portfolioId: string) => ["portfolios", portfolioId, "holdings"] as const,

  /** Loans (the Loans domain, v1.1). A loan's payments ledger nests under it
   * — `qk.loanPayments(id)` is `["loans", id, "payments"]` — so invalidating
   * the bare `qk.loans` prefix refreshes the loan list, every open loan
   * detail, AND every open payments ledger in one call (TanStack's
   * partial-match invalidation), the exact mechanics `qk.portfolios`/
   * `qk.holdings` use. `useLoans`/`useLoanPayments` suffix their bounded flat
   * reads (`"flat"`) so they never collide with a future keyset walk of the
   * same prefix, while every mutation still invalidates the bare prefix.
   * Every loan/payment mutation ALSO invalidates `["analytics"]` (a loan is a
   * liability/receivable that moves the net-worth series) but NOT `qk.accounts`
   * — a loan never moves an account balance — see `features/loans/useLoans.ts`. */
  loans: ["loans"] as const,
  loan: (id: string) => ["loans", id] as const,
  loanPayments: (loanId: string) => ["loans", loanId, "payments"] as const,

  /** Subscriptions (the Subscriptions domain, v1.2). A single top-level key;
   * `useSubscriptions`'s bounded flat read suffixes it with `"flat"`
   * (`["subscriptions", "flat"]`) and `useSubscriptionTotals` suffixes it with
   * `"totals"` + status — same collision-avoidance move as `qk.loans` — so
   * every subscription mutation's `invalidateQueries({ queryKey:
   * qk.subscriptions })` refreshes both the list and the monthly/annual rollup
   * header via TanStack's prefix match. Unlike loans, a subscription change
   * touches NOTHING else (no `qk.accounts`/`qk.transactions`/`["analytics"]`):
   * it's a tracker, renewing only advances a date and posts no transaction —
   * see `features/subscriptions/useSubscriptions.ts`. */
  subscriptions: ["subscriptions"] as const,

  categories: ["categories"] as const,

  contacts: ["contacts"] as const,

  /** Recurring schedules (the Planned domain, v1.1). A single top-level key;
   * `usePlanned`'s bounded flat read suffixes it with `"flat"`
   * (`["planned", "flat"]`) — same collision-avoidance move as
   * `useContacts`/`useAccounts` — so every schedule mutation's
   * `invalidateQueries({ queryKey: qk.planned })` still covers it via
   * TanStack's prefix match. Posting a schedule also invalidates
   * `qk.transactions()`/`qk.accounts`/`["analytics"]` (it creates a real
   * transaction that moves balances/analytics) — see
   * `features/planned/usePlanned.ts`. */
  planned: ["planned"] as const,

  transfers: ["transfers"] as const,

  activity: ["activity"] as const,

  /** Read-only analytics aggregations (`/analytics/*`, Track E). Plain
   * queries — one cache slot per endpoint, each holding the full per-currency
   * response the router returns (`{currency: [...]}`, never summed across
   * currencies, §4); a chart picks its base currency out of that client-side.
   * Nested under a shared `["analytics"]` prefix so a future
   * `invalidateQueries({ queryKey: ["analytics"] })` (e.g. after a transaction
   * mutation shifts the figures) covers all four at once via TanStack's
   * prefix match.
   *
   * Each key takes an optional `{ from, to }` range: with no range (the
   * dashboard's default view) the key is the bare 2-element array the
   * endpoints default server-side to the last 12 months for; the Insights
   * screen's period selector (Task 4) suffixes the range object so each window
   * (3/6/12 months) is its own cache slot and switching periods refetches
   * rather than showing a stale window. The `{ from, to }` object still nests
   * under the shared `["analytics", <endpoint>]` prefix, so prefix-match
   * invalidation covers every window at once. */
  analytics: {
    netWorth: (range?: AnalyticsRange) => analyticsKey("net-worth", range),
    // The three all-capable breakdowns additionally take the Insights
    // selector's all-time flag (`?all=true` server-side, an `"all"` key slot
    // here); net-worth/cashflow have no all-time read and keep range-only keys.
    netWorthComposition: (range?: AnalyticsRange, allTime?: boolean) =>
      analyticsKey("net-worth-composition", range, allTime),
    cashflow: (range?: AnalyticsRange) => analyticsKey("cashflow", range),
    spendingByCategory: (range?: AnalyticsRange, allTime?: boolean) =>
      analyticsKey("spending-by-category", range, allTime),
    spendingByContact: (range?: AnalyticsRange, allTime?: boolean) =>
      analyticsKey("spending-by-contact", range, allTime),
    /** The dashboard's "what's coming" panel (`/analytics/upcoming`). Unlike
     * the others this endpoint takes no reporting range (its own `within_days`
     * horizon, server-defaulted) and returns a `{ due, over_budget }` object
     * rather than a per-currency map — a single static slot under the shared
     * `["analytics"]` prefix, so an `["analytics"]` invalidation covers it too. */
    upcoming: () => ["analytics", "upcoming"] as const,
    /** The forecast engine (`/analytics/forecast`, Track O v1.4) — projected
     * cash + net-worth points for the next `months` months. Takes no `from`/
     * `to` window (it always looks forward from today, not at a historical
     * range) — just the horizon length, so the key is the bare `["analytics",
     * "forecast"]` slot for the default horizon, or that plus `{ months }`
     * for a non-default one, the same "bare vs. suffixed" shape `analyticsKey`
     * gives every other endpoint here. Still nests under the shared
     * `["analytics"]` prefix for invalidation. */
    forecast: (months?: number) =>
      months ? (["analytics", "forecast", { months }] as const) : (["analytics", "forecast"] as const),
  },

  auditEvents: (filters: AuditEventFilters = {}) => ["audit-events", filters] as const,

  sessions: ["sessions"] as const,

  demo: ["demo"] as const,
};

/**
 * The finance-domain listings a demo-data removal invalidates (`DemoChip`).
 * Deliberately excludes `qk.activity`/`qk.auditEvents` — per CONVENTIONS §7,
 * demo removal deletes only the demo domain rows, never the audit/activity
 * history recording that the demo existed and was removed — and `qk.me`/
 * `qk.sessions`, which aren't finance data at all. `qk.categories` is
 * included: the demo dataset seeds `is_demo=true` categories alongside its
 * accounts/transactions/budgets (`api/src/pecunia/services/demo.py`), so
 * removing demo data can also make categories disappear.
 *
 * `qk.contacts` is included for the same reason as `qk.categories`: the demo
 * dataset seeds `is_demo=true` contacts (unlike categories, a fresh workspace
 * starts with none), so removing demo data can make contacts disappear too.
 *
 * `qk.transfers` is included on the same footing: the demo dataset seeds an
 * `is_demo=true` transfer (and its two legs), so removing demo data must also
 * drop the transfers list — and its legs from every transactions list.
 *
 * `qk.portfolios` is included for the same reason: the demo dataset seeds an
 * `is_demo=true` portfolio with holdings and prices
 * (`api/src/pecunia/services/demo.py`), so removing demo data must drop the
 * portfolios list and (via the nested prefix) every holdings list under it.
 *
 * `qk.loans` is included on the same footing: the demo dataset seeds an
 * `is_demo=true` loan with a few payments
 * (`api/src/pecunia/services/demo.py`), so removing demo data must drop the
 * loans list and (via the nested prefix) every payments ledger under it.
 *
 * `qk.subscriptions` is included on the same footing: the demo dataset seeds
 * a few `is_demo=true` subscriptions (`api/src/pecunia/services/demo.py`), so
 * removing demo data must drop the subscriptions list and (via the nested
 * prefix) the monthly/annual totals rollup along with it.
 */
export const financeQueryKeys = [
  qk.accounts,
  qk.transactions(),
  qk.assets,
  qk.projects,
  qk.budgets,
  qk.categories,
  qk.contacts,
  qk.transfers,
  qk.portfolios,
  qk.loans,
  qk.subscriptions,
] as const;
