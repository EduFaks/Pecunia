/**
 * Query hooks for the forecast tab's two read-only endpoints (Track V):
 * `/analytics/projection` (a per-currency cash projection — optimistic vs.
 * realistic daily balance, a runway estimate, and the components behind each
 * projected month) and `/analytics/debt-payoffs` (every borrowed loan's
 * projected payoff ETA under its current planned payment). Both are plain
 * (non-paginated) queries, the same shape every other `/analytics/*` hook in
 * `features/analytics/useAnalytics.ts` follows: `useProjection` picks one
 * currency's `Projection` out of the per-currency response (base currency by
 * default, via `select`, same move as `useNetWorthSeries`/`useCashflow`);
 * `useDebtPayoffs` returns its flat array as-is, since each row already
 * carries its own currency and is never summed across currencies (§4).
 */

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { usePreferences } from "../../lib/preferences";
import { qk } from "../../lib/queries";

/** One projected month's breakdown behind `ProjectionPoint.components` —
 * mirrors `ProjectionComponents` (`api/src/pecunia/api/analytics.py`),
 * integer minor units (§4). */
export interface ProjectionComponents {
  income_minor: number;
  subscriptions_minor: number;
  loans_minor: number;
  card_bills_minor: number;
  variable_minor: number;
}

/** One dated line on a credit card's projected bill, folded into the month it
 * falls due — mirrors `CardBillLabel`. */
export interface CardBillLabel {
  label: string;
  amount_minor: number;
}

/** One projected month-end on the cash projection — mirrors `ProjectionPoint`.
 * `date` is an ISO date; `optimistic_minor` assumes nothing beyond what's
 * already committed on file (scheduled income, subscriptions, loan payments,
 * card bills), `realistic_minor` additionally deducts the cumulative average
 * monthly "variable" spend over the last `variable_lookback_months` (see
 * `Projection`) — the honest "if unplanned spending keeps pace" line. */
export interface ProjectionPoint {
  date: string;
  optimistic_minor: number;
  realistic_minor: number;
  components: ProjectionComponents;
  card_bill_labels: CardBillLabel[];
}

/** One currency's full cash projection — mirrors `ProjectionOut`.
 * `runway_months`/`runway_until` are both `null` when the realistic line
 * never dips below zero (today included) within the projected horizon;
 * `lowest_point`/`recovery` are read off that same realistic line (seeded
 * with today's actual balance ahead of the projected points, so an
 * already-negative balance today is never hidden). `recovery` is `null` when
 * a negative dip never climbs back to zero within the horizon. */
export interface Projection {
  currency: string;
  points: ProjectionPoint[];
  runway_months: number | null;
  runway_until: string | null;
  lowest_point: { value_minor: number; date: string };
  recovery: { date: string; value_minor: number } | null;
  variable_lookback_months: number;
}

/** One borrowed loan's projected payoff ETA under its current planned
 * payment, no interest modeled — mirrors `DebtPayoutOut`
 * (`api/src/pecunia/api/analytics.py`). `payoff_date`/`payments_left` are
 * both `null` when the loan isn't projected to clear within the server's
 * horizon at this pace. */
export interface DebtPayoff {
  loan_id: string;
  name: string;
  remaining_minor: number;
  principal_minor: number;
  planned_payment_minor: number;
  payment_frequency: string;
  currency: string;
  payoff_date: string | null;
  payments_left: number | null;
}

/** The per-currency envelope `/analytics/projection` returns. */
export type ProjectionResponse = Record<string, Projection>;

/** Appends the required `months` horizon for `/analytics/projection` — kept
 * here (pure, exported for its unit tests) alongside `forecastPath`'s
 * identical move in `features/analytics/useAnalytics.ts`. Unlike
 * `forecastPath`, `months` isn't optional: the forecast tab's horizon toggle
 * always has a concrete value (6 or 12) to send. */
export function projectionPath(months: number): string {
  return `/analytics/projection?months=${months}`;
}

/**
 * Picks one currency's projection out of the per-currency
 * `/analytics/projection` response, `undefined` for a currency absent from
 * the response (or while still loading) — same shape as
 * `useAnalytics.ts`'s `selectSummary`. Kept pure and exported so the
 * selection is unit-testable without rendering a hook.
 */
export function selectProjection(
  data: ProjectionResponse | undefined,
  currency: string,
): Projection | undefined {
  return data?.[currency];
}

/**
 * The forecast tab's cash projection (Track V) — one currency's `Projection`
 * picked out of the per-currency `/analytics/projection?months=` response
 * (base currency, the same `select`-side pick every other analytics hook
 * makes). `months` is the screen's horizon toggle (6 or 12) and rides in the
 * query key (`qk.analytics.projection`), so switching it is a distinct cache
 * slot that refetches rather than showing a stale horizon.
 */
export function useProjection(months: number) {
  const { base_currency } = usePreferences();
  return useQuery({
    queryKey: qk.analytics.projection(months),
    queryFn: () => apiFetch<ProjectionResponse>(projectionPath(months)),
    select: (data) => selectProjection(data, base_currency),
  });
}

/**
 * The forecast tab's debt list (Track V) — every borrowed loan's projected
 * payoff ETA, as-is (not per-currency: each row carries its own currency,
 * never summed, §4). No reporting window, so a single bare
 * `qk.analytics.debtPayoffs()` slot, the same shape `useUpcoming` uses.
 */
export function useDebtPayoffs() {
  return useQuery({
    queryKey: qk.analytics.debtPayoffs(),
    queryFn: () => apiFetch<DebtPayoff[]>("/analytics/debt-payoffs"),
  });
}
