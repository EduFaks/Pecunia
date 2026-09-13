/**
 * Pure percent ↔ basis-points conversion for a loan's optional interest rate
 * — kept dependency-free and framework-agnostic so `LoanForm` can round-trip
 * a human-facing percent (`4.25`) through the integer basis points the
 * backend stores (`interest_rate_bps`, DISPLAY only in V1), and so the
 * conversion is trivially unit-testable without rendering anything (same
 * rationale as `features/projects/funding.ts`).
 *
 * 1% = 100 bps, so `bps = round(pct * 100)` and `pct = bps / 100`. The round
 * on the way in keeps a typed `4.255` from landing a hair off an integer bps
 * value; there is no float-precision money concern here (bps is an integer
 * count, not a currency amount), so plain arithmetic is fine.
 */

/** `4.25` → `425` bps. `null`/empty/blank input → `null` (no rate set —
 * nothing to convert, not an error). Returns `null` for non-numeric input. */
export function pctToBps(pct: string | number | null): number | null {
  if (pct === null) {
    return null;
  }
  const value = typeof pct === "number" ? pct : Number(pct.trim());
  if (typeof pct === "string" && pct.trim() === "") {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 100);
}

/** `425` bps → `4.25`. `null` bps (no rate stored) → `null`. */
export function bpsToPct(bps: number | null): number | null {
  if (bps === null) {
    return null;
  }
  return bps / 100;
}

/** `425` bps → `"4.25"` for prefilling the percent input when editing a loan
 * (drops a trailing `.0`, so `500` bps shows as `"5"`, not `"5.0"`). Empty
 * string when no rate is stored. */
export function bpsToPctInput(bps: number | null): string {
  const pct = bpsToPct(bps);
  return pct === null ? "" : String(pct);
}
