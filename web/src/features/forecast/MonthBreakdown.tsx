import { useState } from "react";
import Select from "../../components/ui/Select";
import type { SelectOption } from "../../components/ui/Select";
import { MoneyText } from "../../lib/preferences";
import {
  breakdownRows,
  defaultBreakdownDate,
  findPointByDate,
  monthDeltaMinor,
  SIGN_NEGATIVE,
  SIGN_POSITIVE,
} from "./forecastCopy";
import type { ProjectionPoint } from "./useForecast";

/** A compact month-and-year option label ("nov. 2026") for the month
 * switcher — the same UTC-read move `ProjectionChart`'s own (unexported)
 * `monthLabel` makes, duplicated here rather than imported so this stays a
 * single-purpose display helper next to its one caller. */
function monthOptionLabel(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(iso),
  );
}

export interface MonthBreakdownProps {
  /** The horizon's month-end points, oldest first — the same `points` array
   * `ProjectionChart` renders, re-used here as the month switcher's option
   * list and the source of whichever month is selected. */
  points: ProjectionPoint[];
  /** `Projection.lowest_point.date` — the default selected month when it is
   * genuinely one of `points` (see `defaultBreakdownDate`). */
  lowestPointDate: string;
  /** `Projection.variable_lookback_months` — names the "variável médio"
   * row's lookback window ("média de N meses"). */
  variableLookbackMonths: number;
  currency: string;
  locale?: string;
}

/**
 * The forecast tab's "o que compõe" per-month breakdown (Task 4): a
 * signed/colored list of the selected month's `components` (income,
 * subscriptions, loans, card bills — expanded per card when labeled,
 * variable spend with its lookback caption), each row only rendered when
 * non-zero (`breakdownRows`), followed by two distinct total lines:
 *
 * - "Variação do mês" — `monthDeltaMinor(rows)`, the signed sum of the ROWS
 *   ABOVE IT ONLY. This is computed from those same rows (not re-derived
 *   from `components` a second way), so it is guaranteed to reconcile
 *   exactly with what they show — no black box.
 * - "Saldo projetado" — the month's own `realistic_minor` as-is, shown
 *   separately below a second divider with a deliberately more muted label.
 *   This is the RUNNING cash balance, which also bakes in every EARLIER
 *   month's own change plus today's starting balance
 *   (`ProjectionService.project`'s `running_optimistic`/`cumulative_variable`
 *   accumulators) — it generally does NOT equal "Variação do mês" past the
 *   first projected month, and nothing here implies it does (no "→" off the
 *   rows, no shared total styling with the reconciling line above it).
 *
 * A small `Select` switches which projected month is shown, defaulting to
 * the lowest-point month (or the first projected month when the dip is
 * today's seeded balance rather than any plotted point —
 * `defaultBreakdownDate`).
 */
function MonthBreakdown({
  points,
  lowestPointDate,
  variableLookbackMonths,
  currency,
  locale,
}: MonthBreakdownProps) {
  const [selectedDate, setSelectedDate] = useState<string>(
    () => defaultBreakdownDate(points, lowestPointDate) ?? "",
  );

  const selectedPoint = findPointByDate(points, selectedDate) ?? points[0];
  if (!selectedPoint) {
    return null;
  }

  const rows = breakdownRows(
    selectedPoint.components,
    selectedPoint.card_bill_labels,
    variableLookbackMonths,
  );
  const monthDelta = monthDeltaMinor(rows);
  const options: SelectOption[] = points.map((point) => ({
    value: point.date,
    label: monthOptionLabel(point.date, locale),
  }));

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 min-w-0">
        <h2 className="font-display text-lg text-ink">O que compõe</h2>
        {/* No width override: `Select`'s own `w-full` resolves against this
            flex item's shrink-to-fit size, so it naturally sizes to its
            widest option label rather than stretching the row — the same
            "let the flex item's intrinsic size win" the `TextField`/`Select`
            kit already relies on wherever it isn't placed in an explicitly
            sized grid cell (`TransactionFilters`' own `Select` usages). */}
        <Select
          label="Mês"
          value={selectedDate}
          onChange={(event) => setSelectedDate(event.target.value)}
          options={options}
        />
      </div>

      <ul className="mt-4 flex flex-col divide-y divide-hairline text-sm min-w-0">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 min-w-0"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-ink-2">{row.label}</span>
              {row.caption ? <span className="text-xs text-ink-faint">{row.caption}</span> : null}
            </span>
            <span className={row.tone === "positive" ? "text-positive" : "text-negative"}>
              {row.tone === "positive" ? SIGN_POSITIVE : SIGN_NEGATIVE}
              <MoneyText minor={row.minor} currency={currency} />
            </span>
          </li>
        ))}
      </ul>

      {/* "Variação do mês" sums the rows directly above it, and only them —
          `monthDelta` is computed from those same rows, so this line is
          guaranteed to reconcile with what they show. `colorBySign`: a
          genuine delta, not a plain balance (CONVENTIONS §9.1). */}
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-hairline pt-3 min-w-0">
        <span className="text-sm text-ink-2">Variação do mês</span>
        <MoneyText minor={monthDelta} currency={currency} colorBySign className="text-base" />
      </div>

      {/* "Saldo projetado" is a SEPARATE figure — the running end-of-month
          balance, not a total of the rows/variação above — kept visually
          distinct with its own divider, a muted eyebrow label, and no arrow
          implying it's derived from them. `flagNegative`: a plain running
          balance/total, not a delta (CONVENTIONS §9.1). */}
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-hairline pt-3 min-w-0">
        <span className="text-xs text-ink-faint">Saldo projetado</span>
        <MoneyText
          minor={selectedPoint.realistic_minor}
          currency={currency}
          flagNegative
          className="text-sm text-ink-2"
        />
      </div>
    </div>
  );
}

export default MonthBreakdown;
