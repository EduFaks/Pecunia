import { describe, expect, it } from "vitest";
import { analyticsPath, forecastPath, selectCurrency, selectSummary } from "./useAnalytics";
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

describe("forecastPath", () => {
  it("builds a bare path when no horizon is given (server-defaulted 6 months)", () => {
    expect(forecastPath()).toBe("/analytics/forecast");
  });

  it("appends months for an explicit horizon", () => {
    expect(forecastPath(3)).toBe("/analytics/forecast?months=3");
  });
});

describe("selectSummary", () => {
  const SUMMARY = {
    USD: {
      savings: {
        income_minor: 10000, spend_minor: 4000, saved_minor: 6000, rate_bps: 6000,
        prev_saved_minor: 0, prev_rate_bps: 0,
      },
      committed_monthly: { total_minor: 5000, subscriptions_minor: 5000, loans_minor: 0, planned_minor: 0 },
      net_worth_change: {
        now_minor: 105000, start_of_month_minor: 70000, delta_minor: 35000, pct_bps: 5000, movers: [],
      },
    },
  };

  it("picks the requested currency's summary out of the per-currency response", () => {
    expect(selectSummary(SUMMARY, "USD")).toEqual(SUMMARY.USD);
  });

  it("returns undefined for a currency absent from the response", () => {
    expect(selectSummary(SUMMARY, "EUR")).toBeUndefined();
  });

  it("returns undefined when the response is undefined (still loading)", () => {
    expect(selectSummary(undefined, "USD")).toBeUndefined();
  });
});
