/**
 * Pure used/limit math for `AccountsCardsCard.tsx`'s linked-credit-card
 * progress bar — kept in its own module (not exported from the component
 * file) so Fast Refresh stays happy, same move `budgetProgress.ts`/
 * `goalProgress.ts` already make for their own card's pure math.
 */

export interface CreditCardUsage {
  /** 0–100, clamped — a balance far beyond the limit still reads as a full
   * bar, not an overflowing one (`overLimit` carries the semantic instead),
   * same move `budgetProgress`'s `percent` makes. */
  percent: number;
  /** `true` once the card's outstanding balance exceeds its credit limit. */
  overLimit: boolean;
}

/**
 * `null` when there's nothing to compute a percentage of — no credit limit
 * on file, or a non-positive one — so the caller renders no bar at all
 * rather than a fabricated 0%/100% one (mirrors `budgetProgress`'s
 * `hasActual` guard, just expressed as `null` instead of a flag since
 * there's no other field to carry alongside it here). The outstanding
 * balance is taken as a magnitude (`abs`) — a credit card's
 * `derived_balance_minor` is a liability, sign-agnostic for this purpose.
 */
export function creditCardUsage(
  derivedBalanceMinor: number,
  creditLimitMinor: number | null,
): CreditCardUsage | null {
  if (creditLimitMinor === null || creditLimitMinor <= 0) {
    return null;
  }
  const used = Math.abs(derivedBalanceMinor);
  const raw = (used / creditLimitMinor) * 100;
  return { percent: Math.max(0, Math.min(100, raw)), overLimit: used > creditLimitMinor };
}
