import { cn } from "../../lib/cn";
import { focusRingClass } from "../../components/ui/a11y";
import { PERIOD_OPTIONS } from "./period";

export interface PeriodSelectorProps {
  months: number;
  onChange: (months: number) => void;
}

/**
 * The shared last-3/6/12-months reporting-period selector — a segmented
 * `role="group"` of toggles (the app's established pattern, `TransactionForm`'s
 * direction toggle). The active window carries the neutral accent-soft tint (a
 * selection, not value movement, so never emerald/coral); `aria-pressed` marks
 * the choice for assistive tech.
 *
 * Extracted from `InsightsScreen` so the Insights breakdowns and a contact's
 * overview (`ContactDetail`) drive their `{ from, to }` windows from the one
 * selector — the month count it emits pairs with `computePeriodRange` (see
 * `period.ts`) to build the range the `/analytics/*` + overview hooks accept.
 */
export function PeriodSelector({ months, onChange }: PeriodSelectorProps) {
  return (
    <div
      role="group"
      aria-label="Reporting period"
      className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
    >
      {PERIOD_OPTIONS.map((option) => (
        <button
          key={option.months}
          type="button"
          aria-pressed={months === option.months}
          onClick={() => onChange(option.months)}
          className={cn(
            "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
            months === option.months
              ? "bg-accent-soft text-ink"
              : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            focusRingClass,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default PeriodSelector;
