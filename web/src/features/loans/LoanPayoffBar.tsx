import Pill from "../../components/ui/Pill";
import { cn } from "../../lib/cn";
import { MoneyText } from "../../lib/preferences";
import { payoffProgress } from "./payoff";

export interface LoanPayoffBarProps {
  /** Σ payments made, `LoanOut.paid_total_minor` (integer minor units). */
  paidTotalMinor: number;
  /** The original loan amount, `LoanOut.principal_minor`. */
  principalMinor: number;
  /** `max(principal − paid, 0)`, `LoanOut.remaining_minor` — drives the
   * "Paid off" state and the remaining caption. */
  remainingMinor: number;
  currency: string;
  className?: string;
}

/**
 * Loan payoff progress bar — `LoansScreen`'s list row and `LoanDetail`'s
 * header both render this. The fill is the white accent (`bg-accent`, the
 * CONVENTIONS §9.1 sanctioned exception to "the accent is interactive-only":
 * a payoff bar is progress toward something the user is acting on, exactly
 * like `FundingBar`). Paying down a debt is unambiguously good, so — unlike
 * `BudgetVsActualBar`/`FundingBar`'s over-target coral switch — this bar
 * never turns coral; a fully-paid loan (`remaining === 0`) stays accent and
 * gets a positive "Paid off" `Pill` instead. No text renders on top of the
 * fill, so no `text-on-accent` contrast fix applies here.
 *
 * A loan with no principal renders the paid amount alone — no bar, no
 * fabricated percentage of nothing.
 */
function LoanPayoffBar({
  paidTotalMinor,
  principalMinor,
  remainingMinor,
  currency,
  className,
}: LoanPayoffBarProps) {
  const progress = payoffProgress(paidTotalMinor, principalMinor, remainingMinor);

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5">
          <MoneyText minor={paidTotalMinor} currency={currency} />
          <span className="text-xs text-ink-faint">paid</span>
        </span>
        {progress.hasPrincipal ? (
          <span className="flex items-center gap-1.5">
            {progress.paidOff ? (
              <Pill tone="positive">Paid off</Pill>
            ) : (
              <>
                <span className="text-xs text-ink-faint">remaining</span>
                <MoneyText minor={remainingMinor} currency={currency} />
              </>
            )}
          </span>
        ) : null}
      </div>
      {progress.hasPrincipal ? (
        <div
          role="progressbar"
          aria-valuenow={Math.round(progress.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Payoff progress"
          className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div
            data-payoff-fill
            className="h-full rounded-full bg-accent transition-[width] duration-150 ease-pc"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export default LoanPayoffBar;
