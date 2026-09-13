/**
 * Pure payoff-progress math for a loan's payoff bar (`LoanPayoffBar.tsx`) —
 * kept dependency-free and framework-agnostic so the paid/principal %, the
 * paid-off flag, and the has-principal guard are trivially unit-testable
 * without rendering anything, same rationale as
 * `features/projects/funding.ts` and `features/budgets/budgetProgress.ts`.
 *
 * `paid_total_minor` is Σ payments and `remaining_minor` is
 * `max(principal − paid_total, 0)` (both computed server-side). Progress is
 * `paid / principal`, clamped 0–100 — an overpaid loan reads as a full bar,
 * not an overflowing one. "Paid off" is keyed off `remaining === 0` rather
 * than the raw percentage, so a loan whose payments exactly (or more than)
 * cover the principal reads complete.
 */

export interface PayoffProgress {
  /** 0–100, clamped. */
  percent: number;
  /** `true` once `remaining_minor === 0` (with a principal to pay off) — the
   * loan is fully settled and the bar reads complete. */
  paidOff: boolean;
  /** `false` when `principalMinor <= 0` — a loan with no principal has
   * nothing to show a percentage of (dividing by zero isn't "0%", it's "not
   * applicable"), same guard as `fundingProgress.hasTarget`. */
  hasPrincipal: boolean;
}

export function payoffProgress(
  paidTotalMinor: number,
  principalMinor: number,
  remainingMinor: number,
): PayoffProgress {
  if (principalMinor <= 0) {
    return { percent: 0, paidOff: false, hasPrincipal: false };
  }

  const raw = (paidTotalMinor / principalMinor) * 100;
  const percent = Math.max(0, Math.min(100, raw));
  return {
    percent,
    paidOff: remainingMinor === 0,
    hasPrincipal: true,
  };
}
