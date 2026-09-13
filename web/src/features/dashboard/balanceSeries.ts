import type { ChartPoint } from "../../components/charts/chartMath";

/** The fields this module reads off a `GET /transactions` row. */
export interface TransactionLite {
  occurred_on: string;
  amount_minor: number;
}

/**
 * Reconstructs a chronological running-balance series from an account's
 * *current* `balance_minor` plus its transactions as `/transactions`
 * returns them — newest-first (CONVENTIONS §6's keyset-pagination order).
 *
 * There is no net-worth/balance-history endpoint in V1, so this is the
 * "available series" the dataviz constraint calls for: walk the newest-
 * first list backward, subtracting each transaction's `amount_minor` from
 * the running total to reconstruct the balance immediately after each
 * earlier transaction, then reverse to chronological order. The result is
 * exact for the transactions given — if the caller fetched only the most
 * recent page (not full history), the earliest point is "balance after the
 * oldest transaction in this window," an honest partial-window view, never
 * a fabricated one.
 *
 * Points are spaced one-per-transaction (by order, not by elapsed calendar
 * time); the sparkline in `AccountsSnapshot` renders them as a Recharts line.
 */
export function buildBalanceSeries(
  currentBalanceMinor: number,
  transactionsNewestFirst: TransactionLite[],
): ChartPoint[] {
  const points: ChartPoint[] = [];
  let runningBalance = currentBalanceMinor;

  for (const transaction of transactionsNewestFirst) {
    points.push({ date: transaction.occurred_on, valueMinor: runningBalance });
    runningBalance -= transaction.amount_minor;
  }

  return points.reverse();
}
