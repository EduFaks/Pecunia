/**
 * Pure, render-free data helpers shared by the Recharts charts — trend
 * direction plus the one-sentence `aria-label` summaries every chart's
 * `role="img"` figure carries (a screen reader gets the summary the SVG can't
 * convey). Kept dependency-free and framework-agnostic so they're trivially
 * unit-testable without rendering anything.
 */

import { formatDate } from "../../lib/format";
import { formatMoney } from "../../lib/money";

/** One data point: an ISO date (or date-time) and an integer minor-units
 * value (CONVENTIONS §4 — money is never a float). */
export interface ChartPoint {
  date: string;
  valueMinor: number;
}

export type TrendDirection = "up" | "down" | "flat";

/** Overall direction from the first point to the last — "flat" for fewer
 * than two points or no net movement. */
export function trendDirection(points: ChartPoint[]): TrendDirection {
  if (points.length < 2) {
    return "flat";
  }
  const first = points[0].valueMinor;
  const last = points[points.length - 1].valueMinor;
  if (last > first) {
    return "up";
  }
  if (last < first) {
    return "down";
  }
  return "flat";
}

/** One period's income and spend, both integer minor units (§4). */
export interface CashflowBar {
  /** ISO date for the period start (a month start in v1.1). */
  periodStart: string;
  incomeMinor: number;
  spendMinor: number;
}

/** One breakdown slice. `color` is a category's stored hex, or `null` for the
 * "Uncategorized" bucket (the component paints null with a neutral token). */
export interface DonutDatum {
  key: string;
  label: string;
  valueMinor: number;
  color: string | null;
}

/** One breakdown row: a stable `key`, a display `label`, and an integer
 * minor-units value (§4). Extra fields (e.g. a secondary `note`) ride
 * alongside untouched. */
export interface BreakdownItem {
  key: string;
  label: string;
  valueMinor: number;
  [extra: string]: unknown;
}

/** One-sentence `aria-label` for a ranked breakdown bar list — the ranking's
 * name, its total, and the largest row. `label` names the breakdown ("Spending
 * by contact", "Project spend"). */
export function describeBreakdownBars(
  label: string,
  items: BreakdownItem[],
  currency: string,
  locale?: string,
): string {
  const positive = items.filter((item) => item.valueMinor > 0);
  if (positive.length === 0) {
    return `${label}: No data available.`;
  }
  const total = positive.reduce((sum, item) => sum + item.valueMinor, 0);
  const largest = positive.reduce((top, item) => (item.valueMinor > top.valueMinor ? item : top));
  return `${label}, ${formatMoney(total, currency, locale)} across ${positive.length}: largest is ${largest.label} at ${formatMoney(largest.valueMinor, currency, locale)}.`;
}

/** One-sentence `aria-label` for an income-vs-spend chart — totals income and
 * spend across the periods shown. */
export function describeCashflow(bars: CashflowBar[], currency: string, locale?: string): string {
  if (bars.length === 0) {
    return "Income vs spend: No data available.";
  }
  const income = bars.reduce((sum, bar) => sum + bar.incomeMinor, 0);
  const spend = bars.reduce((sum, bar) => sum + bar.spendMinor, 0);
  return `Income vs spend across ${bars.length} months: ${formatMoney(income, currency, locale)} income, ${formatMoney(spend, currency, locale)} spend.`;
}

/** One-sentence `aria-label` for a category breakdown — the total and the
 * largest slice. Assumes `data` is sorted by value descending (the analytics
 * response is). */
export function describeBreakdown(data: DonutDatum[], currency: string, locale?: string): string {
  const positive = data.filter((datum) => datum.valueMinor > 0);
  if (positive.length === 0) {
    return "Spending by category: No data available.";
  }
  const total = positive.reduce((sum, datum) => sum + datum.valueMinor, 0);
  const largest = positive[0];
  return `Spending by category, ${formatMoney(total, currency, locale)} across ${positive.length} categories: largest is ${largest.label} at ${formatMoney(largest.valueMinor, currency, locale)}.`;
}

/** One projected month from `/analytics/forecast` — a future point plus its
 * uncertainty band. Mirrors `ForecastPoint` (`api/src/pecunia/api/analytics.py`),
 * camelCased and pre-converted from `date`/`*_minor` (see `useForecast`). */
export interface ForecastChartPoint {
  date: string;
  valueMinor: number;
  lowerMinor: number;
  upperMinor: number;
}

/** One row of the merged history+forecast series `ForecastArea` feeds
 * Recharts. `historyValue` is set on real (solid) history rows;
 * `projectedValue`/`lower`/`bandWidth` are set on the dashed-tail rows. Only
 * `date` is guaranteed — every other field is present only where it applies,
 * so a `<Line>`/`<Area>` reading the "wrong" key for a row simply skips it
 * (Recharts treats a missing value as a gap, not a zero). */
export interface MergedForecastPoint {
  date: string;
  historyValue?: number;
  projectedValue?: number;
  lower?: number;
  bandWidth?: number;
}

/**
 * Merges a real (solid) history series with a projected (dashed) tail into
 * the one row-per-date array `ForecastArea` charts: `historyValue` for
 * history rows, `projectedValue`/`lower`/`bandWidth` for projected rows.
 * `bandWidth` (not `upperMinor` directly) is what a stacked `<Area>` draws —
 * an invisible `lower` area stacked under a visible `bandWidth` area lands
 * the visible band's top at `lower + bandWidth == upperMinor`, the standard
 * Recharts range-band technique.
 *
 * When both a history and a projected series are given, the LAST history
 * point is duplicated onto `projectedValue` too (a "bridge" row) — a
 * `<Line>` only draws between two rows that both define its `dataKey`, so
 * without the bridge the dashed line would start one point late, leaving a
 * visible gap where it should instead pick up exactly at the solid line's
 * end.
 */
export function mergeForecastSeries(
  history: ChartPoint[],
  projected: ForecastChartPoint[],
): MergedForecastPoint[] {
  const historyRows: MergedForecastPoint[] = history.map((point) => ({
    date: point.date,
    historyValue: point.valueMinor,
  }));
  const projectedRows: MergedForecastPoint[] = projected.map((point) => ({
    date: point.date,
    projectedValue: point.valueMinor,
    lower: point.lowerMinor,
    bandWidth: point.upperMinor - point.lowerMinor,
  }));

  if (historyRows.length === 0 || projectedRows.length === 0) {
    return [...historyRows, ...projectedRows];
  }

  const lastHistoryIndex = historyRows.length - 1;
  const bridged = historyRows.slice(0, lastHistoryIndex).concat({
    ...historyRows[lastHistoryIndex],
    projectedValue: historyRows[lastHistoryIndex].historyValue,
  });
  return [...bridged, ...projectedRows];
}

/** One-sentence `aria-label` for a forecast chart's dashed tail — the metric
 * name and the final projected figure. `label` names the metric ("Cash
 * forecast", "Net worth"). */
export function describeForecast(
  label: string,
  projected: ForecastChartPoint[],
  currency: string,
  locale?: string,
): string {
  if (projected.length === 0) {
    return `${label}: no forecast available.`;
  }
  const last = projected[projected.length - 1];
  return `${label}: projected to ${formatMoney(last.valueMinor, currency, locale)} by ${formatDate(last.date, { locale })}.`;
}

/**
 * A one-sentence trend summary for a chart's `aria-label` — "Checking:
 * trending up, from $1,234.00 on Jan 1, 2026 to $2,000.00 on Jan 3, 2026."
 * `label` is the caller's name for the series (an account name, "Net
 * worth", …).
 */
export function describeTrend(
  label: string,
  points: ChartPoint[],
  currency: string,
  locale?: string,
): string {
  if (points.length === 0) {
    return `${label}: no data available.`;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const direction = trendDirection(points);
  const firstText = `${formatMoney(first.valueMinor, currency, locale)} on ${formatDate(first.date, { locale })}`;
  const lastText = `${formatMoney(last.valueMinor, currency, locale)} on ${formatDate(last.date, { locale })}`;
  if (points.length === 1 || first === last) {
    return `${label}: ${lastText}.`;
  }
  return `${label}: trending ${direction}, from ${firstText} to ${lastText}.`;
}
