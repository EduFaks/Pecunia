/**
 * Plain-decimal ↔ integer-minor-units conversion for a currency-aware
 * amount input. Deliberately separate from `lib/money.ts`'s `parseMoney`
 * (which parses a *formatted*, locale-symbol-laden string like "$1,234.56"
 * back out) — here the input is a bare decimal a user types directly (e.g.
 * "84.99"), always period-as-decimal regardless of locale (an ordinary text
 * field, not a currency-symbol combobox). Lives in `lib/` (not under either
 * feature) since both `features/transactions`' amount field (sign via a
 * separate inflow/outflow toggle) and `features/accounts`' optional
 * starting-balance field (sign typed directly) share it.
 *
 * Built on string arithmetic, never `Number(x) * factor` — floating-point
 * multiplication of a decimal like 84.99 can land a hair off its integer
 * cent value, which is exactly the failure mode CONVENTIONS §4 rules out
 * for money. `minorUnitFactor` (`./money.ts`) still supplies the per-
 * currency digit count (2 for USD, 0 for JPY, 3 for BHD) — the one piece of
 * currency-specific knowledge this module needs, not duplicated here.
 */

import { minorUnitFactor } from "./money";

const DECIMAL_INPUT_PATTERN = /^-?\d*\.?\d*$/;

function digitsForCurrency(currency: string): number {
  return Math.round(Math.log10(minorUnitFactor(currency)));
}

/**
 * Converts a typed decimal string (e.g. "84.99", "1000", "-5") into integer
 * minor units for `currency`, rounding half-up when more fractional digits
 * are typed than the currency supports. Any leading minus sign is stripped
 * — this always returns a non-negative amount; the caller applies sign via
 * the inflow/outflow toggle. Returns `null` for empty or non-numeric input
 * (nothing to convert yet, not an error to throw).
 */
export function amountToMinor(input: string, currency: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || !DECIMAL_INPUT_PATTERN.test(trimmed)) {
    return null;
  }

  const unsigned = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const digits = digitsForCurrency(currency);

  let minor = BigInt((wholePart || "0") + fractionPart.padEnd(digits, "0").slice(0, digits));
  const roundingDigit = fractionPart[digits];
  if (roundingDigit !== undefined && Number(roundingDigit) >= 5) {
    minor += 1n;
  }

  return Number(minor);
}

/**
 * `amountToMinor`'s sign-preserving sibling, for the rare field where the
 * sign is typed directly rather than chosen via a separate inflow/outflow
 * toggle — `AccountForm`'s optional starting balance (a credit card can
 * reasonably start owed, i.e. negative; `TransactionIn`'s
 * `initial_balance_minor` is unconstrained on sign — see
 * `api/src/pecunia/money.py`'s `MinorInt`).
 */
export function signedAmountToMinor(input: string, currency: string): number | null {
  const trimmed = input.trim();
  const negative = trimmed.startsWith("-");
  const magnitude = amountToMinor(negative ? trimmed.slice(1) : trimmed, currency);
  if (magnitude === null) {
    return null;
  }
  return negative ? -magnitude : magnitude;
}

/**
 * Renders an absolute (sign-dropped) minor-units amount as a plain decimal
 * string for prefilling the amount input when editing an existing
 * transaction — the inverse of `amountToMinor`, and the pair this module
 * exports for `TransactionForm` to round-trip through.
 */
export function minorToAmountInput(minor: number, currency: string): string {
  const digits = digitsForCurrency(currency);
  const absMinor = Math.abs(Math.trunc(minor)).toString().padStart(digits + 1, "0");
  if (digits === 0) {
    return absMinor;
  }
  const splitAt = absMinor.length - digits;
  return `${absMinor.slice(0, splitAt)}.${absMinor.slice(splitAt)}`;
}
