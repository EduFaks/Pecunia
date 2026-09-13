/**
 * Pure budget-vs-actual math for `BudgetVsActualBar.tsx` — kept dependency-
 * free and framework-agnostic, same rationale as `features/projects/
 * funding.ts`'s `fundingProgress` (this file's closest sibling: both feed a
 * progress bar with a clamped percent and a boolean "special state" flag).
 */

export interface BudgetProgress {
  /** 0–100, clamped — spending far beyond the budget still reads as a full
   * bar, not an overflowing one; `overBudget` carries the semantic instead
   * of the bar's width. */
  percent: number;
  /** `true` once `actualMinor > amountMinor` — the bar's fill switches from
   * the white accent to the negative (coral) token when this is true. */
  overBudget: boolean;
  /** `false` when `actualMinor` is `null` — the backend returns `null` for
   * a budget with no `category_id` (nothing to sum spend against), so
   * there's no bar to show at all, not a 0% one. */
  hasActual: boolean;
}

export function budgetProgress(actualMinor: number | null, amountMinor: number): BudgetProgress {
  if (actualMinor === null) {
    return { percent: 0, overBudget: false, hasActual: false };
  }

  const overBudget = actualMinor > amountMinor;
  if (amountMinor <= 0) {
    // A zero/negative budget amount can't express a meaningful percent —
    // any positive spend already reads as "over" via `overBudget`, so a
    // full bar communicates that without dividing by zero.
    return { percent: actualMinor > 0 ? 100 : 0, overBudget, hasActual: true };
  }

  const raw = (actualMinor / amountMinor) * 100;
  const percent = Math.max(0, Math.min(100, raw));
  return { percent, overBudget, hasActual: true };
}
