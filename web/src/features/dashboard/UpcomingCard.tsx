import { DateText, MoneyText } from "../../lib/preferences";
import { useUpcoming } from "../analytics/useAnalytics";
import type { UpcomingDue } from "../analytics/useAnalytics";

const MS_PER_DAY = 86_400_000;

/** This card's horizon — a tighter, more urgent window than `UpcomingWidget`'s
 * 30-day panel (same `/analytics/upcoming` data, just filtered client-side:
 * the hook takes no params, see its docstring). */
const WITHIN_DAYS = 14;

/** Start-of-day in UTC for an ISO date string (or a Date), so the day-count
 * math is timezone-stable — same rationale as `UpcomingWidget`'s identical
 * helper and `formatDate`'s UTC getters. */
function utcMidnight(value: string | Date): number {
  const d = typeof value === "string" ? new Date(value) : value;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whether an ISO due date falls within `WITHIN_DAYS` of today (inclusive).
 * The server only ever surfaces items due today or later (see `useUpcoming`),
 * so there's no overdue case to exclude here — just the farther-out tail. */
function isWithinHorizon(dueOn: string): boolean {
  const days = Math.round((utcMidnight(dueOn) - utcMidnight(new Date())) / MS_PER_DAY);
  return days >= 0 && days <= WITHIN_DAYS;
}

/**
 * A compact "what's due soon" dashboard card — the next 14 days' planned
 * items, subscription renewals and loan payments, reusing the same
 * `/analytics/upcoming` data `UpcomingWidget` reads (the hook takes no
 * params, so both cards share one cache slot — no extra request when both
 * are mounted). Rows are a single line: due date, label, signed amount.
 * Receivables (a positive planned amount) render in positive tone, bills
 * (negative) in negative tone; a loan's planned payment is a
 * direction-agnostic magnitude, so it stays neutral regardless of sign —
 * matching `UpcomingWidget`. Tokens only; a calm empty state when nothing's
 * due in the window.
 */
function UpcomingCard() {
  const { data, isLoading, isError } = useUpcoming();

  const due = data?.due ?? [];
  const upcoming: UpcomingDue[] = due
    .filter((item) => isWithinHorizon(item.due_on))
    .slice()
    .sort((a, b) => a.due_on.localeCompare(b.due_on));

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <h2 className="font-display text-lg text-ink">Next 14 days</h2>

      {isError ? (
        <p className="mt-4 text-sm text-ink-faint">
          Couldn't load what's upcoming. Try refreshing.
        </p>
      ) : isLoading ? (
        <p className="mt-4 text-sm text-ink-2">Loading…</p>
      ) : upcoming.length === 0 ? (
        <p className="mt-4 text-sm text-ink-2">nada nos próximos 14 dias</p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-hairline">
          {upcoming.map((item) => (
            <li
              key={`${item.kind}:${item.id}`}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <DateText iso={item.due_on} className="shrink-0 text-xs text-ink-faint" />
                <span className="truncate font-sans text-sm text-ink">{item.label}</span>
              </span>
              {item.amount_minor !== null ? (
                <MoneyText
                  minor={item.amount_minor}
                  currency={item.currency}
                  // A loan's planned payment is a direction-agnostic positive
                  // magnitude, not value movement — render it neutrally
                  // (matches `UpcomingWidget`/`LoanDetail`), never colored.
                  colorBySign={item.kind !== "loan"}
                  className="shrink-0 text-sm"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default UpcomingCard;
