import { Link } from "react-router-dom";
import GoalRing from "../goals/GoalRing";
import { useGoals } from "../goals/useGoals";

/** How many goals the dashboard preview shows before an "and N more" link —
 * a glanceable preview, not the full list (that's `/goals`, `GoalsScreen`). */
const MAX_GOALS_SHOWN = 3;

/**
 * The dashboard's savings-goals summary (Track S, v1.4): the top few goals'
 * progress rings (`GoalRing`, each carrying its server-computed
 * `progress`/`eta`). Every row links out to `/goals` — there is no per-goal
 * detail route (progress/eta are derived, not a ledger to drill into), so
 * unlike `UpcomingWidget`'s per-kind routing this widget has just the one
 * destination. A fresh workspace with no goals gets a calm empty state with
 * a CTA, matching `SavingsRateCard`/`UpcomingWidget`.
 */
function GoalsWidget() {
  const { data, isLoading, isError } = useGoals();
  const goals = data?.items ?? [];
  const shown = goals.slice(0, MAX_GOALS_SHOWN);
  const remaining = goals.length - shown.length;

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <h2 className="font-display text-lg text-ink">Goals</h2>

      {isError ? (
        <p className="mt-4 text-sm text-ink-faint">Couldn't load your goals. Try refreshing.</p>
      ) : isLoading ? (
        <p className="mt-4 text-sm text-ink-2">Loading…</p>
      ) : goals.length === 0 ? (
        <p className="mt-4 text-sm text-ink-2">
          No savings goals yet.{" "}
          <Link
            to="/goals"
            className="text-ink underline decoration-hairline-strong underline-offset-2 transition-colors duration-150 ease-pc hover:text-accent"
          >
            Set one up
          </Link>
          .
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {shown.map((goal) => (
            <Link
              key={goal.id}
              to="/goals"
              className="rounded-pc transition-colors duration-150 ease-pc hover:bg-surface-2"
            >
              <GoalRing goal={goal} size={64} />
            </Link>
          ))}
          {remaining > 0 ? (
            <Link
              to="/goals"
              className="text-xs text-ink-faint transition-colors duration-150 ease-pc hover:text-accent"
            >
              and {remaining} more goal{remaining === 1 ? "" : "s"} →
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default GoalsWidget;
