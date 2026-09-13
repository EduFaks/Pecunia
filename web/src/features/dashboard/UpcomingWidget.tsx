import { AlertTriangle, CalendarClock, Landmark, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { useUpcoming } from "../analytics/useAnalytics";
import type { UpcomingDue } from "../analytics/useAnalytics";

const MS_PER_DAY = 86_400_000;

/** Beyond this many days out, a row shows a short calendar date instead of a
 * relative "in N days" — near-term items read best as a countdown, farther
 * ones as an actual date. */
const RELATIVE_DAY_THRESHOLD = 14;

/** The lucide icon per due kind (mirrors the sidebar's Planned/Subscriptions/
 * Loans nav marks, `AppShell.tsx`). Decorative — always `aria-hidden`. */
const KIND_ICON: Record<UpcomingDue["kind"], LucideIcon> = {
  planned: CalendarClock,
  subscription: RefreshCw,
  loan: Landmark,
};

/** The owning screen each due kind links to. */
const KIND_ROUTE: Record<UpcomingDue["kind"], string> = {
  planned: "/planned",
  subscription: "/subscriptions",
  loan: "/loans",
};

/** Start-of-day in UTC for an ISO date string (or a Date), so the day-count
 * math is timezone-stable — same rationale as `formatDate`'s UTC getters. */
function utcMidnight(value: string | Date): number {
  const d = typeof value === "string" ? new Date(value) : value;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Compact "Sep 30"-style date, read in UTC (matches the charts' `shortDate`). */
function shortDate(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** A glanceable due label: "Today" / "Tomorrow" / "in N days" for the near
 * term, a short calendar date farther out. The server only surfaces items due
 * today or later, so a non-positive diff means today. */
function dueLabel(iso: string, locale?: string): string {
  const days = Math.round((utcMidnight(iso) - utcMidnight(new Date())) / MS_PER_DAY);
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Tomorrow";
  }
  if (days <= RELATIVE_DAY_THRESHOLD) {
    return `in ${days} days`;
  }
  return shortDate(iso, locale);
}

/**
 * The dashboard's forward-looking panel — at a glance, what's coming: the
 * soonest planned items, subscription renewals and loan payments due (next 30
 * days, `/analytics/upcoming`), plus any budgets currently over. The `due`
 * list arrives already sorted soonest-first and capped server-side, so it's
 * rendered in order; each row links to the screen that owns the item. An
 * over-budget section (alert-toned) surfaces overruns beneath it, and a fresh
 * or quiet workspace gets a calm empty state rather than an empty card. Tokens
 * only; a loan with no planned payment shows just its label + due date.
 */
function UpcomingWidget() {
  const { locale } = usePreferences();
  const { data, isLoading, isError } = useUpcoming();

  const due = data?.due ?? [];
  const overBudget = data?.over_budget ?? [];
  const isEmpty = due.length === 0 && overBudget.length === 0;

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <h2 className="font-display text-lg text-ink">Upcoming</h2>

      {isError ? (
        <p className="mt-4 text-sm text-ink-faint">
          Couldn't load what's upcoming. Try refreshing.
        </p>
      ) : isLoading ? (
        <p className="mt-4 text-sm text-ink-2">Loading…</p>
      ) : isEmpty ? (
        <p className="mt-4 text-sm text-ink-2">Nothing due in the next 30 days.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {due.length > 0 ? (
            <ul className="flex flex-col divide-y divide-hairline">
              {due.map((item) => {
                const Icon = KIND_ICON[item.kind];
                return (
                  <li key={`${item.kind}:${item.id}`}>
                    <Link
                      to={KIND_ROUTE[item.kind]}
                      className="group flex items-center justify-between gap-3 py-3"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-faint" />
                        <span className="min-w-0">
                          <span className="block truncate font-sans text-sm text-ink transition-colors duration-150 ease-pc group-hover:text-accent">
                            {item.label}
                          </span>
                          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                            {dueLabel(item.due_on, locale)}
                          </span>
                        </span>
                      </span>
                      {item.amount_minor !== null ? (
                        <MoneyText
                          minor={item.amount_minor}
                          currency={item.currency}
                          // A loan's planned payment is a direction-agnostic
                          // positive magnitude, not value movement — render it
                          // neutrally (matches `LoanDetail`), never emerald.
                          colorBySign={item.kind !== "loan"}
                          className="shrink-0 text-sm"
                        />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {overBudget.length > 0 ? (
            <div className={due.length > 0 ? "border-t border-hairline pt-4" : ""}>
              <h3 className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.1em] text-ink-faint">
                <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-negative" />
                Over budget
              </h3>
              <ul className="mt-2 flex flex-col divide-y divide-hairline">
                {overBudget.map((budget) => (
                  <li key={budget.budget_id}>
                    <Link
                      to="/budgets"
                      className="group flex items-center justify-between gap-3 py-3"
                    >
                      <span className="min-w-0 truncate font-sans text-sm text-ink transition-colors duration-150 ease-pc group-hover:text-accent">
                        {budget.label}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-ink-2">
                        over by{" "}
                        <MoneyText
                          minor={budget.over_minor}
                          currency={budget.currency}
                          className="text-negative"
                        />{" "}
                        of <MoneyText minor={budget.amount_minor} currency={budget.currency} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default UpcomingWidget;
