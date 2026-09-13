import Pill from "../../components/ui/Pill";
import { cn } from "../../lib/cn";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { describeGoalEta, goalRingProgress } from "./goalProgress";
import type { GoalOut } from "./useGoals";

export interface GoalRingProps {
  goal: GoalOut;
  /** The ring's diameter in px. Defaults to a size that reads well stacked
   * in `GoalsScreen`'s list or side-by-side on the Dashboard. */
  size?: number;
  className?: string;
}

const STROKE_WIDTH = 8;

/**
 * A savings goal's progress ring — `GoalsScreen`'s list row and the
 * Dashboard's goals summary widget both render this. The fill is the white
 * accent (`stroke-accent`), the CONVENTIONS §9.1 sanctioned "progress toward
 * a bound" exception (alongside `FundingBar`/`BudgetVsActualBar`/
 * `LoanPayoffBar`/the wizard's step indicator/the password-strength meter):
 * a savings goal is unambiguously something the user is working toward, not
 * decoration. Reaching (or passing) the target is unambiguously good, so —
 * like `LoanPayoffBar` — the ring never switches to coral; it stays accent
 * and gets a positive "Goal reached" `Pill` instead.
 *
 * The percentage sits in plain ink text in the ring's center (not on top of
 * the accent stroke itself — a ring's fill is a thin arc, not a filled
 * surface, so the `text-on-accent` contrast rule doesn't apply here, same as
 * the linear progress bars).
 */
function GoalRing({ goal, size = 96, className }: GoalRingProps) {
  const { locale } = usePreferences();
  const { percent, reached } = goalRingProgress(goal.progress.pct_bps);
  const etaLine = describeGoalEta(reached, goal.eta, locale);

  const radius = (size - STROKE_WIDTH) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  const center = size / 2;

  return (
    <div className={cn("flex items-center gap-4", className)}>
      <div
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${goal.name} progress`}
        className="relative shrink-0"
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            className="stroke-surface-2"
          />
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="stroke-accent transition-[stroke-dashoffset] duration-300 ease-pc"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-sm tabular-figures text-ink">{Math.round(percent)}%</span>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-sm text-ink">{goal.name}</p>
        <p className="flex flex-wrap items-baseline gap-1 text-xs text-ink-faint">
          <MoneyText minor={goal.progress.current_minor} currency={goal.currency} />
          <span>of</span>
          <MoneyText minor={goal.progress.target_minor} currency={goal.currency} />
        </p>
        {reached ? (
          <Pill tone="positive">{etaLine}</Pill>
        ) : (
          <p className="text-xs text-ink-faint">{etaLine}</p>
        )}
      </div>
    </div>
  );
}

export default GoalRing;
