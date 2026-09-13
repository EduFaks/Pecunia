/**
 * Display + input helpers for a holding's `quantity` — a fractional
 * share/unit count, NOT money (CONVENTIONS §4: money is integer minor units;
 * quantity is a `Numeric(28,8)` the API serializes as a STRING to preserve
 * exact precision). These stay string-based end to end — never `Number(x)`
 * for the value that gets sent — so a tiny fractional quantity like
 * `0.00000001` round-trips without a float landing a hair off.
 */

/** A non-negative decimal, at most 8 fractional digits (mirrors the backend's
 * `Numeric(28,8)` / `decimal_places=8`). Used to validate typed input; the
 * whole-part digit cap is left to the backend's `422` (max_digits=28). */
const QUANTITY_PATTERN = /^\d*\.?\d{0,8}$/;

/**
 * Renders a stored quantity string (e.g. `"12.50000000"`) for display,
 * trimming trailing zeros to a sensible precision (`"12.5"`, `"100"`,
 * `"0.00000001"`). A value with no decimal point, or one this can't parse as
 * a finite number, is returned unchanged — defensive, never throws.
 */
export function formatQuantity(quantity: string): string {
  if (!quantity.includes(".")) {
    return quantity;
  }
  if (!Number.isFinite(Number(quantity))) {
    return quantity;
  }
  const trimmed = quantity.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

/**
 * Validates a typed quantity and returns it as a trimmed string ready to send
 * to the API, or `null` for empty / non-numeric / non-positive input (nothing
 * to submit yet, not an error to throw). Requires a strictly positive value —
 * a holding of zero (or negative) shares is meaningless.
 */
export function parseQuantity(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "." || !QUANTITY_PATTERN.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return trimmed;
}
