/**
 * Pure goal-progress/ETA math for `GoalRing` — kept dependency-free and
 * framework-agnostic so the ring's clamped fill percent, its "reached"
 * flag, and the ETA caption are trivially unit-testable without rendering
 * anything, same rationale as `features/projects/funding.ts` and
 * `features/loans/payoff.ts`.
 */

export interface GoalRingProgress {
  /** 0–100, clamped — a goal past its target still reads as a full ring,
   * not an overflowing one (mirrors `fundingProgress`/`payoffProgress`). */
  percent: number;
  /** `true` once `pctBps >= 10_000` (100%) — the goal has reached (or
   * passed) its target. */
  reached: boolean;
}

export function goalRingProgress(pctBps: number): GoalRingProgress {
  const percent = Math.max(0, Math.min(100, pctBps / 100));
  return { percent, reached: pctBps >= 10_000 };
}

export interface GoalEtaLike {
  reached_on: string | null;
  on_track: boolean;
}

/** A short month/year label from an ISO date, read in UTC so it doesn't
 * drift with the viewer's timezone (same rationale as `formatDate`). */
function monthYearLabel(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/**
 * The ETA caption `GoalRing` shows under a goal's name: "Goal reached" once
 * the target is met (`reached`, derived from `goalRingProgress` — takes
 * priority over `eta`, since a goal at/past its target is unambiguously
 * done regardless of the forecast), an on-track goal's projected month
 * (`eta.on_track && eta.reached_on`), or a plain "not on track" line when
 * `GoalService.eta` never reaches the target within its 6-month horizon.
 */
export function describeGoalEta(reached: boolean, eta: GoalEtaLike, locale?: string): string {
  if (reached) {
    return "Goal reached";
  }
  if (eta.on_track && eta.reached_on) {
    return `On track — by ${monthYearLabel(eta.reached_on, locale)}`;
  }
  return "Not on track within 6 months";
}
