import { describe, expect, it } from "vitest";
import { buildBalanceSeries } from "./balanceSeries";
import type { TransactionLite } from "./balanceSeries";

describe("buildBalanceSeries", () => {
  it("reconstructs the running balance backward from the current total, then returns it chronologically", () => {
    // Current balance is 1000. Newest-first transactions (as /transactions
    // returns them): +100 on day 3, -50 on day 2, +200 on day 1.
    const txsNewestFirst: TransactionLite[] = [
      { occurred_on: "2026-01-03", amount_minor: 100 },
      { occurred_on: "2026-01-02", amount_minor: -50 },
      { occurred_on: "2026-01-01", amount_minor: 200 },
    ];

    const series = buildBalanceSeries(1000, txsNewestFirst);

    // Chronological: after day1 tx (+200) balance was 1000-100-(-50)... walk
    // backward from 1000: after day3 = 1000; before day3 (=after day2) =
    // 1000-100=900; before day2 (=after day1) = 900-(-50)=950.
    expect(series).toEqual([
      { date: "2026-01-01", valueMinor: 950 },
      { date: "2026-01-02", valueMinor: 900 },
      { date: "2026-01-03", valueMinor: 1000 },
    ]);
  });

  it("returns an empty series for no transactions", () => {
    expect(buildBalanceSeries(1000, [])).toEqual([]);
  });

  it("returns a single point for a single transaction, equal to the current balance", () => {
    const series = buildBalanceSeries(500, [{ occurred_on: "2026-01-01", amount_minor: 500 }]);
    expect(series).toEqual([{ date: "2026-01-01", valueMinor: 500 }]);
  });
});
