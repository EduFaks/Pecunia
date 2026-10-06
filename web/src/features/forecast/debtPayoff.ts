/**
 * Pure payoff-progress math for `DebtPayoffList`'s small progress bar — kept
 * dependency-free and framework-agnostic, the same "exported pure function
 * next to the component that uses it, in its own file so it stays Fast
 * Refresh-friendly" move `features/loans/payoff.ts` and this feature's own
 * `forecastCopy.ts` already make.
 */

/**
 * A debt row's payoff-progress fraction (0–1) — deliberately NOT
 * `payoff.ts`'s `payoffProgress` (paid/principal), because `DebtPayoff`
 * (`./useForecast`) carries no principal at all: `remaining_minor` is the
 * current flat ledger balance (CONVENTIONS §4, same shape as
 * `LoanOut.remaining_minor`), so there is no honest "paid" figure to divide
 * by an original amount this endpoint never returns. `payoff.ts`'s own
 * docstring says as much for this exact situation — "if principal isn't
 * available, a remaining-only bar is fine — keep it honest; don't invent a
 * principal."
 *
 * Instead: `1 / paymentsLeft` — the fraction of the remaining PAYMENT COUNT
 * that the very next payment alone knocks out. One payment left reads as a
 * full bar (the next payment finishes it); many payments left read as a
 * thin sliver. This needs no principal and no paid-total, nothing beyond
 * the one field the server already computed — it isn't "% of debt paid
 * off", it's "how close is the finish line", which is the only progress
 * notion these fields can honestly support. `paymentsLeft <= 0` (already
 * clear as of today) also reads as a full bar — there is nothing left to
 * pay down.
 */
export function debtPayoffFraction(paymentsLeft: number): number {
  if (paymentsLeft <= 0) {
    return 1;
  }
  return Math.max(0, Math.min(1, 1 / paymentsLeft));
}
