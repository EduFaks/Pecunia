import { cn } from "../../lib/cn";
import { focusRingClass } from "../../components/ui/a11y";
import { PERIOD_OPTIONS } from "./period";
import type { PeriodSelection } from "./period";

export interface PeriodSelectorProps {
  value: PeriodSelection;
  onChange: (selection: PeriodSelection) => void;
  /** Whether the "All time" option is offered (default). Screens whose backing
   * endpoint has no all-time read (`ContactDetail`'s overview always takes a
   * bounded `{ from, to }`) pass `false` to keep only the month windows. */
  includeAllTime?: boolean;
}

/**
 * The shared reporting-period selector — a segmented `role="group"` of toggles
 * (the app's established pattern, `TransactionForm`'s direction toggle)
 * offering the last 3 / 6 / 12 / 24 months plus an "All time" mode. The active
 * window carries the neutral accent-soft tint (a selection, not value
 * movement, so never emerald/coral); `aria-pressed` marks the choice for
 * assistive tech.
 *
 * Emits a `PeriodSelection` (see `period.ts`): a bounded month count pairs
 * with `computePeriodRange` to build the `{ from, to }` the `/analytics/*` +
 * overview hooks accept, while "All time" is a distinct mode with no client
 * range — the all-capable analytics hooks send `?all=true` instead.
 */
export function PeriodSelector({ value, onChange, includeAllTime = true }: PeriodSelectorProps) {
  const optionClass = (pressed: boolean) =>
    cn(
      "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
      pressed ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
      focusRingClass,
    );

  return (
    <div
      role="group"
      aria-label="Reporting period"
      className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
    >
      {PERIOD_OPTIONS.map((option) => {
        const pressed = value.kind === "months" && value.months === option.months;
        return (
          <button
            key={option.months}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange({ kind: "months", months: option.months })}
            className={optionClass(pressed)}
          >
            {option.label}
          </button>
        );
      })}
      {includeAllTime ? (
        <button
          type="button"
          aria-pressed={value.kind === "all"}
          onClick={() => onChange({ kind: "all" })}
          className={optionClass(value.kind === "all")}
        >
          All time
        </button>
      ) : null}
    </div>
  );
}

export default PeriodSelector;
