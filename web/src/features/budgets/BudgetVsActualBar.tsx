import { cn } from "../../lib/cn";
import { MoneyText } from "../../lib/preferences";
import { budgetProgress } from "./budgetProgress";

export interface BudgetVsActualBarProps {
  /** `null` when the budget has no `category_id` — `BudgetOut.actual_minor`
   * is `null` in exactly that case (nothing to sum spend against). */
  actualMinor: number | null;
  amountMinor: number;
  currency: string;
  className?: string;
}

/**
 * Budget-vs-actual progress bar — `BudgetsScreen`'s row for any budget that
 * has a category. The fill is the white accent (`bg-accent`) while under
 * budget — the sanctioned progress-fill exception, CONVENTIONS §9.1, same
 * one `FundingBar` uses — switching to the negative token (`bg-negative`,
 * coral) once `actual > amount`: unlike a funding goal, going over budget
 * *is* a real semantic bad state, not just "more progress," so the color
 * change here (not just the label) is deliberate and distinct from
 * `FundingBar`'s accent-only fill. No text renders on top of the fill, so
 * no `text-on-accent` contrast fix applies here. Remaining/over renders via
 * `MoneyText` per the firm contract, coral-colored only when over.
 *
 * A categoryless budget (`actualMinor === null`) renders no bar at all —
 * there's nothing to compute a percentage of — just a short caption
 * pointing at the fix.
 */
function BudgetVsActualBar({ actualMinor, amountMinor, currency, className }: BudgetVsActualBarProps) {
  const progress = budgetProgress(actualMinor, amountMinor);

  if (!progress.hasActual || actualMinor === null) {
    return (
      <p className={cn("text-xs text-ink-faint", className)}>Set a category to track spending.</p>
    );
  }

  const remaining = amountMinor - actualMinor;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5">
          <MoneyText minor={actualMinor} currency={currency} />
          <span className="text-xs text-ink-faint">spent</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-ink-faint">{progress.overBudget ? "over by" : "remaining"}</span>
          <MoneyText
            minor={Math.abs(remaining)}
            currency={currency}
            className={progress.overBudget ? "text-negative" : undefined}
          />
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(progress.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Budget progress"
        className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div
          data-budget-fill
          className={cn(
            "h-full rounded-full transition-[width] duration-150 ease-pc",
            progress.overBudget ? "bg-negative" : "bg-accent",
          )}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}

export default BudgetVsActualBar;
