import Pill from "../../components/ui/Pill";
import { cn } from "../../lib/cn";
import { MoneyText } from "../../lib/preferences";
import { fundingProgress } from "./funding";
import { projectTypeLabels } from "./projectTypes";
import type { ProjectType } from "./projectTypes";

export interface FundingBarProps {
  /** The project's realized funding — Σ ABS(linked transactions),
   * `ProjectOut.actual_minor`. */
  actualMinor: number;
  /** `null` when the project has no `target_amount_minor` set —
   * `target_amount_minor` is optional on `ProjectIn`/`ProjectOut`. */
  targetAmountMinor: number | null;
  currency: string;
  /** Drives the vocabulary and the over-target color rule (see below).
   * Defaults to spending, matching the backend column default. */
  type?: ProjectType;
  className?: string;
}

/**
 * Actual/target progress bar — `ProjectsScreen`'s list row and
 * `ProjectDetail`'s header both render this. The fill is the white accent
 * (`bg-accent`, per the firm contract: a funding bar is progress toward
 * something the user is acting on, the CONVENTIONS §9.1 sanctioned exception
 * to "the accent is interactive-only").
 *
 * The bar is **type-aware** two ways:
 *   - **vocabulary** — a saving project reads "saved … of goal", a spending
 *     one "spent … of budget" (`projectTypeLabels`), so the same bar suits a
 *     rainy-day fund and a kitchen remodel;
 *   - **over-target color** — a *spending* project that goes past its budget
 *     switches the fill from accent to the negative token (`bg-negative`,
 *     coral) and shows an "Over budget" `Pill tone="negative"`, exactly like
 *     `BudgetVsActualBar` (the second sanctioned accent→coral switch §9.1
 *     allows: overspending is a real bad state, not just "more progress"). A
 *     *saving* project that reaches its goal is unambiguously good, so it
 *     stays accent and gets a positive "Goal reached" `Pill` instead — never
 *     coral. No text renders on top of the fill, so no `text-on-accent`
 *     contrast fix applies here.
 *
 * A project with no `target_amount_minor` renders the actual amount alone —
 * no bar, no fabricated percentage of nothing.
 */
function FundingBar({ actualMinor, targetAmountMinor, currency, type = "spending", className }: FundingBarProps) {
  const progress = fundingProgress(actualMinor, targetAmountMinor);
  const labels = projectTypeLabels(type);
  const overBudget = type === "spending" && progress.overTarget;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5">
          <MoneyText minor={actualMinor} currency={currency} />
          <span className="text-xs text-ink-faint">{labels.actual.toLowerCase()}</span>
        </span>
        {progress.hasTarget ? (
          <span className="flex items-center gap-1.5">
            <span className="text-xs text-ink-faint">of {labels.target.toLowerCase()}</span>
            <MoneyText minor={targetAmountMinor ?? 0} currency={currency} />
            {overBudget ? (
              <Pill tone="negative">Over budget</Pill>
            ) : type === "saving" && progress.targetReached ? (
              <Pill tone="positive">Goal reached</Pill>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-ink-faint">No {labels.target.toLowerCase()} set</span>
        )}
      </div>
      {progress.hasTarget ? (
        <div
          role="progressbar"
          aria-valuenow={Math.round(progress.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Funding progress"
          className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div
            data-funding-fill
            className={cn(
              "h-full rounded-full transition-[width] duration-150 ease-pc",
              overBudget ? "bg-negative" : "bg-accent",
            )}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export default FundingBar;
