/**
 * Pure payoff-progress math for `DebtPayoffList`'s small progress bar — kept
 * dependency-free and framework-agnostic, the same "exported pure function
 * next to the component that uses it, in its own file so it stays Fast
 * Refresh-friendly" move `features/loans/payoff.ts` and this feature's own
 * `forecastCopy.ts` already make.
 */

import { payoffProgress } from "../loans/payoff";

/**
 * A debt row's TRUE payoff-progress fraction (0–1): `(principal_minor −
 * remaining_minor) / principal_minor`, i.e. how much of the original debt
 * has actually been paid off — not a stand-in like "how close is the next
 * payment to clearing it" (that read as a standard "% complete" bar while
 * meaning something else entirely; see git history for the earlier
 * `1 / paymentsLeft` version this replaces).
 *
 * `DebtPayoff` (`./useForecast`) now carries `principal_minor` alongside the
 * flat `remaining_minor` ledger balance (CONVENTIONS §4), so the paid total
 * is simply `principal_minor − remaining_minor` — reusing
 * `features/loans/payoff.ts`'s `payoffProgress` for the actual percent/clamp
 * math (same formula, same 0–100 clamp, same `principal_minor <= 0` guard)
 * rather than duplicating it here.
 */
export function debtPayoffFraction(principalMinor: number, remainingMinor: number): number {
  const paidTotalMinor = principalMinor - remainingMinor;
  return payoffProgress(paidTotalMinor, principalMinor, remainingMinor).percent / 100;
}
