/**
 * Money is stored and transmitted as integer minor units (see
 * docs/CONVENTIONS.md §4) — e.g. USD cents, BHD fils. Formatting must divide
 * by each currency's *actual* minor-unit factor, which is not always 100:
 * JPY has 0 minor-unit digits (factor 1) and BHD has 3 (factor 1000). The
 * factor is derived from `Intl.NumberFormat`'s own `minimumFractionDigits`
 * for the currency rather than hardcoded, so it's correct for every ISO 4217
 * currency without a lookup table to maintain.
 */

function factorFromFormatter(formatter: Intl.NumberFormat): number {
  // `style: "currency"` always resolves minimumFractionDigits from the
  // currency's ISO 4217 minor-unit digits (JPY: 0, BHD: 3, most others: 2);
  // the `?? 2` only guards TS's optional typing, not a real runtime case.
  const digits = formatter.resolvedOptions().minimumFractionDigits ?? 2;
  return 10 ** digits;
}

/**
 * The minor-unit factor for a currency (100 for USD, 1 for JPY, 1000 for
 * BHD) — the same `Intl`-derived logic `formatMoney`/`parseMoney` use
 * internally, exposed for callers that need the raw factor without a full
 * format/parse round trip (e.g. `features/transactions`'s amount input,
 * which maps a typed decimal straight to integer minor units).
 */
export function minorUnitFactor(currency: string, locale?: string): number {
  return factorFromFormatter(new Intl.NumberFormat(locale, { style: "currency", currency }));
}

/** Formats an integer minor-units amount as a localized currency string. */
export function formatMoney(minor: number, currency: string, locale?: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const factor = factorFromFormatter(formatter);
  return formatter.format(minor / factor);
}

/**
 * Parses a localized currency string back into integer minor units. Best
 * effort: strips everything but digits, sign, and the locale/currency's own
 * grouping and decimal separators, then rounds to the nearest minor unit.
 */
export function parseMoney(input: string, currency: string, locale?: string): number {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  const factor = factorFromFormatter(formatter);

  const parts = formatter.formatToParts(-1234.5);
  const groupSeparator = parts.find((part) => part.type === "group")?.value ?? ",";
  const decimalSeparator = parts.find((part) => part.type === "decimal")?.value ?? ".";

  const numeric = input
    .trim()
    .split(groupSeparator)
    .join("")
    .split(decimalSeparator)
    .join(".")
    // Keep digits, the decimal point, and any minus sign; drop currency
    // symbols/codes and other locale literals (spaces, non-breaking spaces).
    .replace(/[^\d.-]/g, "");

  const value = Number(numeric);
  if (Number.isNaN(value)) {
    throw new Error(`Cannot parse money value: ${input}`);
  }

  return Math.round(value * factor);
}
