import { describe, expect, it } from "vitest";
import { selectCurrency } from "./useAnalytics";
import type { NetWorthPoint, PerCurrency } from "./useAnalytics";

const RESPONSE: PerCurrency<NetWorthPoint> = {
  USD: [
    { date: "2026-01-01", net_worth_minor: 100000 },
    { date: "2026-02-01", net_worth_minor: 120000 },
  ],
  EUR: [{ date: "2026-01-01", net_worth_minor: 50000 }],
};

describe("selectCurrency", () => {
  it("picks the requested currency's list out of a multi-currency response", () => {
    expect(selectCurrency(RESPONSE, "USD")).toHaveLength(2);
    expect(selectCurrency(RESPONSE, "EUR")).toHaveLength(1);
  });

  it("returns an empty list for a currency absent from the response", () => {
    expect(selectCurrency(RESPONSE, "GBP")).toEqual([]);
  });

  it("returns an empty list when the response is undefined (still loading)", () => {
    expect(selectCurrency(undefined, "USD")).toEqual([]);
  });
});
