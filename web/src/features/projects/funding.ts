/**
 * Pure funding-progress math for a project's funding bar (`FundingBar.tsx`)
 * — kept dependency-free and framework-agnostic so the actual/target %,
 * the target-reached flag, and the over-target flag are trivially
 * unit-testable without rendering anything, same rationale as
 * `components/charts/chartMath.ts` and its close sibling
 * `features/budgets/budgetProgress.ts`.
 *
 * "Actual" is the project's realized funding — Σ ABS(linked transactions),
 * `ProjectOut.actual_minor` — measured against `target_amount_minor` (the
 * goal for a saving project, the budget for a spending one). The old
 * "funded = Σ items" figure is now `planned_minor` and no longer drives the
 * bar.
 */

export interface FundingProgress {
  /** 0–100, clamped — a project past its target still reads as a full bar,
   * not an overflowing one; `overTarget` carries "beyond" instead of the
   * width, exactly as `budgetProgress` does. */
  percent: number;
  /** `true` once `actualMinor >= targetAmountMinor` (and a target exists) —
   * a saving goal *reached*. */
  targetReached: boolean;
  /** `true` once `actualMinor > targetAmountMinor` (strictly past it). A
   * spending project uses this to switch its bar to the negative token
   * (over budget); a saving project ignores it (reaching the goal is good,
   * exceeding it is still just accent). */
  overTarget: boolean;
  /** `false` when `targetAmountMinor` is `null`/`0` — `ProjectIn.
   * target_amount_minor` is optional, and a project with no target has
   * nothing to show a percentage of (dividing by zero isn't "0%", it's
   * "not applicable"). */
  hasTarget: boolean;
}

export function fundingProgress(
  actualMinor: number,
  targetAmountMinor: number | null,
): FundingProgress {
  if (targetAmountMinor === null || targetAmountMinor <= 0) {
    return { percent: 0, targetReached: false, overTarget: false, hasTarget: false };
  }

  const raw = (actualMinor / targetAmountMinor) * 100;
  const percent = Math.max(0, Math.min(100, raw));
  return {
    percent,
    targetReached: actualMinor >= targetAmountMinor,
    overTarget: actualMinor > targetAmountMinor,
    hasTarget: true,
  };
}
