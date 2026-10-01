/**
 * Pure segment math for `SafeToSpendCard`'s segmented month-total bar —
 * kept in its own module (not exported from the component file) so Fast
 * Refresh stays happy, same move `creditCardUsage.ts`/`budgetProgress.ts`/
 * `goalProgress.ts` already make for their own card's pure math.
 *
 * Unlike the old single spend-progress bar (`safeToSpendPercent`, still
 * exported from `SafeToSpendCard.tsx` for the hero's simpler fill), this bar
 * reads as the whole month: spent, committed-to-come, and what's still free,
 * each a percentage of `expected_income_minor` — the month's total, not a
 * shrinking "safe to spend" ceiling.
 */

export interface SafeToSpendSegmentsInput {
  expected_income_minor: number;
  spent_mtd_minor: number;
  committed_remaining_minor: number;
  /** Not used in the percentage math below (spent/committed/free already
   * fully determine each other once the month total is fixed) — accepted so
   * callers can pass the whole `SafeToSpend` entry through without picking
   * fields by hand. */
  displayed_safe_minor: number;
  monthly_budget_minor: number | null;
}

export interface SafeToSpendSegments {
  /** 0-100 — `spent_mtd_minor` as a percent of `expected_income_minor`,
   * clamped so it alone never exceeds 100. */
  spentPct: number;
  /** 0-100 — `committed_remaining_minor` as a percent of
   * `expected_income_minor`, clamped to whatever room `spentPct` left so the
   * pair never exceeds 100 (spent always wins the room — it already
   * happened, committed hasn't). */
  committedPct: number;
  /** 0-100 — whatever's left after `spentPct`/`committedPct`; floors at 0
   * rather than going negative when the two above already fill the bar. */
  freePct: number;
  /** `monthly_budget_minor` as a percent of `expected_income_minor`, clamped
   * 0-100 — `null` when there's no budget set or `expected_income_minor` is
   * non-positive (nothing to position a marker against). */
  budgetMarkerPct: number | null;
}

const EMPTY_SEGMENTS: SafeToSpendSegments = {
  spentPct: 0,
  committedPct: 0,
  freePct: 0,
  budgetMarkerPct: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Splits the month total (`expected_income_minor`) into the bar's three
 * stacked segments plus an optional budget-marker position. Guards
 * divide-by-zero (and a nonsensical negative income) the same way: a
 * non-positive `expected_income_minor` has nothing to compute a percentage
 * of, so every percentage is 0 and the marker is `null` — never `NaN`.
 */
export function safeToSpendSegments(input: SafeToSpendSegmentsInput): SafeToSpendSegments {
  const { expected_income_minor, spent_mtd_minor, committed_remaining_minor, monthly_budget_minor } =
    input;

  if (expected_income_minor <= 0) {
    return EMPTY_SEGMENTS;
  }

  const spentPct = clamp((spent_mtd_minor / expected_income_minor) * 100, 0, 100);
  const roomAfterSpent = 100 - spentPct;
  const committedPct = clamp(
    (committed_remaining_minor / expected_income_minor) * 100,
    0,
    roomAfterSpent,
  );
  const freePct = Math.max(0, 100 - spentPct - committedPct);

  const budgetMarkerPct =
    monthly_budget_minor == null
      ? null
      : clamp((monthly_budget_minor / expected_income_minor) * 100, 0, 100);

  return { spentPct, committedPct, freePct, budgetMarkerPct };
}
