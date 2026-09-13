import { describe, expect, it } from "vitest";
import {
  describeBreakdown,
  describeBreakdownBars,
  describeCashflow,
  describeTrend,
  trendDirection,
} from "./chartMath";
import type { CashflowBar, ChartPoint, DonutDatum } from "./chartMath";

const RISING: ChartPoint[] = [
  { date: "2026-01-01", valueMinor: 1000 },
  { date: "2026-01-02", valueMinor: 1500 },
  { date: "2026-01-03", valueMinor: 2000 },
];

describe("trendDirection", () => {
  it("is 'up' when the series ends higher than it starts", () => {
    expect(trendDirection(RISING)).toBe("up");
  });

  it("is 'down' when the series ends lower than it starts", () => {
    expect(trendDirection([...RISING].reverse())).toBe("down");
  });

  it("is 'flat' for a single point or no movement", () => {
    expect(trendDirection([{ date: "2026-01-01", valueMinor: 100 }])).toBe("flat");
    expect(
      trendDirection([
        { date: "2026-01-01", valueMinor: 100 },
        { date: "2026-01-02", valueMinor: 100 },
      ]),
    ).toBe("flat");
  });
});

describe("describeTrend", () => {
  it("summarizes direction and start/end values", () => {
    const text = describeTrend("Checking", RISING, "USD", "en-US");
    expect(text).toContain("Checking");
    expect(text).toContain("up");
    expect(text).toContain("10.00");
    expect(text).toContain("20.00");
  });

  it("reports no data for an empty series", () => {
    expect(describeTrend("Checking", [], "USD", "en-US")).toBe("Checking: no data available.");
  });
});

const CASHFLOW: CashflowBar[] = [
  { periodStart: "2026-01-01", incomeMinor: 400000, spendMinor: 100000 },
  { periodStart: "2026-02-01", incomeMinor: 200000, spendMinor: 300000 },
  { periodStart: "2026-03-01", incomeMinor: 0, spendMinor: 0 },
];

describe("describeCashflow", () => {
  it("summarizes total income and spend across the periods", () => {
    const text = describeCashflow(CASHFLOW, "USD", "en-US");
    // Income 400000 + 200000 = 600000 -> $6,000.00; spend 100000 + 300000 = 400000 -> $4,000.00.
    expect(text).toContain("6,000.00");
    expect(text).toContain("4,000.00");
    expect(text).toContain("3");
  });

  it("reports no data for an empty series", () => {
    expect(describeCashflow([], "USD", "en-US")).toContain("No");
  });
});

const BREAKDOWN: DonutDatum[] = [
  { key: "a", label: "Groceries", valueMinor: 30000, color: "#4f83b2" },
  { key: "b", label: "Transport", valueMinor: 10000, color: "#b24f7a" },
  { key: "uncategorized", label: "Uncategorized", valueMinor: 0, color: null },
];

describe("describeBreakdown", () => {
  it("summarizes the total and the largest slice", () => {
    const text = describeBreakdown(BREAKDOWN, "USD", "en-US");
    expect(text).toContain("Groceries");
    expect(text).toContain("400.00");
  });

  it("reports no data for an empty breakdown", () => {
    expect(describeBreakdown([], "USD", "en-US")).toContain("No");
  });
});

describe("describeBreakdownBars", () => {
  it("names the ranking, total, and largest row", () => {
    const label = describeBreakdownBars(
      "Spending by contact",
      [
        { key: "a", label: "Landlord", valueMinor: 50000 },
        { key: "b", label: "Cafe", valueMinor: 10000 },
      ],
      "USD",
      "en-US",
    );
    expect(label).toContain("Spending by contact");
    expect(label).toContain("Landlord");
    expect(label).toContain("600.00"); // total 60000 minor
  });

  it("reports no data for an empty breakdown", () => {
    expect(describeBreakdownBars("Spending by contact", [], "USD", "en-US")).toContain("No");
  });
});
