/**
 * The Insights screen's reporting-period selector. A tiny pure helper that
 * turns a month count (3 / 6 / 12) plus "today" into the `{ from, to }` ISO
 * date range the `/analytics/*` hooks accept — kept out of the component (and
 * clock-free, taking `today` as an argument) so it's unit-testable, mirroring
 * how the backend router owns the wall clock and the service stays pure.
 */

import type { AnalyticsRange } from "../../lib/queries";

export interface PeriodOption {
  months: number;
  label: string;
}

/** The three windows offered by the selector, widest last. */
export const PERIOD_OPTIONS: PeriodOption[] = [
  { months: 3, label: "3 months" },
  { months: 6, label: "6 months" },
  { months: 12, label: "12 months" },
];

/** The selector's default window — the same 12 months the endpoints default
 * to server-side, so the first paint matches the dashboard's figures. */
export const DEFAULT_PERIOD_MONTHS = 12;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC `YYYY-MM-DD` for a date — matches how `lib/format` reads ISO dates in
 * UTC so the window doesn't drift with the viewer's timezone. */
function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * The window ending on `today` and starting `months` calendar months earlier.
 * Subtracts on the UTC calendar and clamps to the last valid day when the
 * start month is shorter than the end day (e.g. Mar 31 − 1 month → Feb 28),
 * rather than letting `Date` roll forward into the next month.
 */
export function computePeriodRange(months: number, today: Date): AnalyticsRange {
  const to = toIsoDate(today);

  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const day = today.getUTCDate();

  const targetMonth = month - months;
  // Last day of the start month, to clamp an out-of-range day into it.
  const lastDayOfStartMonth = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(year, targetMonth, Math.min(day, lastDayOfStartMonth)));

  return { from: toIsoDate(start), to };
}
