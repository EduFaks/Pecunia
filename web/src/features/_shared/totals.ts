/**
 * Pure per-currency aggregation for a list screen's `<SummaryHeader>`
 * (Track P — v1.4). Every domain list already loads its own bounded/flat
 * page (`limit=200`, CONVENTIONS §9.9's "flat" hooks) or, for Transactions,
 * the keyset page currently on screen; this module never fetches anything —
 * it only groups+sums what the caller already has in hand.
 *
 * CONVENTIONS §4: money is integer minor units, **never summed across
 * currencies** — every result is a per-currency figure, grouped exactly like
 * the existing `/analytics/*` and `features/dashboard/balances.ts` do.
 */

/** One currency's total — `{currency, total_minor}[]`, never a single mixed
 * figure. */
export interface CurrencyTotal {
  currency: string;
  total_minor: number;
}

/**
 * Groups `items` by `currency(item)` and sums `amount(item)` within each
 * group — negatives included (a total can go negative, e.g. an overdrawn
 * account), nothing floored or clamped. Order is **stable**: each currency's
 * entry appears in the order it was first seen in `items`, not alphabetical
 * — so a caller that wants the base currency first can simply sort `items`
 * (or the result) itself. An empty `items` list yields `[]` — no currency is
 * invented out of thin air.
 */
export function sumByCurrency<T>(
  items: T[],
  amount: (item: T) => number,
  currency: (item: T) => string,
): CurrencyTotal[] {
  const order: string[] = [];
  const totals = new Map<string, number>();

  for (const item of items) {
    const code = currency(item);
    if (!totals.has(code)) {
      totals.set(code, 0);
      order.push(code);
    }
    totals.set(code, (totals.get(code) ?? 0) + amount(item));
  }

  return order.map((code) => ({ currency: code, total_minor: totals.get(code) ?? 0 }));
}
