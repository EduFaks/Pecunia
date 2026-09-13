import { describe, expect, it } from "vitest";
import { analyticsPath, selectCurrency } from "./useAnalytics";
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

describe("analyticsPath", () => {
  it("builds a bare path when no window is given (server-defaulted range)", () => {
    expect(analyticsPath("cashflow")).toBe("/analytics/cashflow");
  });

  it("appends from/to for a bounded window", () => {
    expect(analyticsPath("spending-by-category", { from: "2026-06-12", to: "2026-09-12" })).toBe(
      "/analytics/spending-by-category?from=2026-06-12&to=2026-09-12",
    );
  });

  it("sends all=true and omits from/to for the all-time mode", () => {
    expect(analyticsPath("spending-by-category", undefined, true)).toBe(
      "/analytics/spending-by-category?all=true",
    );
  });

  it("lets all-time win over a stale range (no from leaks through)", () => {
    expect(analyticsPath("net-worth-composition", { from: "2026-06-12", to: "2026-09-12" }, true)).toBe(
      "/analytics/net-worth-composition?all=true",
    );
  });
});
