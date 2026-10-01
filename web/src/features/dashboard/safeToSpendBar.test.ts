import { describe, expect, it } from "vitest";
import { safeToSpendSegments } from "./safeToSpendBar";

describe("safeToSpendSegments", () => {
  it("splits spent/committed/free as percentages of expected income, summing to 100%", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 50_000,
      spent_mtd_minor: 20_000, // 40%
      committed_remaining_minor: 5_000, // 10%
      displayed_safe_minor: 25_000,
      monthly_budget_minor: null,
    });

    expect(result.spentPct).toBe(40);
    expect(result.committedPct).toBe(10);
    expect(result.freePct).toBe(50);
    expect(result.spentPct + result.committedPct + result.freePct).toBe(100);
    expect(result.budgetMarkerPct).toBeNull();
  });

  it("clamps spent at 100% and leaves no room for committed when spend alone meets income", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 50_000,
      spent_mtd_minor: 60_000, // 120% on its own
      committed_remaining_minor: 10_000,
      displayed_safe_minor: -20_000,
      monthly_budget_minor: null,
    });

    expect(result.spentPct).toBe(100);
    expect(result.committedPct).toBe(0);
    expect(result.freePct).toBe(0);
  });

  it("clamps committed to whatever room is left after spent, so the pair never exceeds 100%", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 50_000,
      spent_mtd_minor: 40_000, // 80%
      committed_remaining_minor: 20_000, // 40% on its own, only 20% room left
      displayed_safe_minor: -10_000,
      monthly_budget_minor: null,
    });

    expect(result.spentPct).toBe(80);
    expect(result.committedPct).toBe(20);
    expect(result.freePct).toBe(0);
    expect(result.spentPct + result.committedPct + result.freePct).toBe(100);
  });

  it("positions the budget marker as a percentage of expected income, clamped 0-100", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 50_000,
      spent_mtd_minor: 10_000,
      committed_remaining_minor: 5_000,
      displayed_safe_minor: 35_000,
      monthly_budget_minor: 25_000,
    });

    expect(result.budgetMarkerPct).toBe(50);
  });

  it("clamps an out-of-range budget marker (over income) at 100", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 50_000,
      spent_mtd_minor: 0,
      committed_remaining_minor: 0,
      displayed_safe_minor: 50_000,
      monthly_budget_minor: 75_000,
    });

    expect(result.budgetMarkerPct).toBe(100);
  });

  it("returns a null marker when no monthly budget is set", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 50_000,
      spent_mtd_minor: 10_000,
      committed_remaining_minor: 5_000,
      displayed_safe_minor: 35_000,
      monthly_budget_minor: null,
    });

    expect(result.budgetMarkerPct).toBeNull();
  });

  it("guards divide-by-zero: zero expected income returns all-zero percentages and a null marker", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 0,
      spent_mtd_minor: 10_000,
      committed_remaining_minor: 5_000,
      displayed_safe_minor: -15_000,
      monthly_budget_minor: 25_000,
    });

    expect(result).toEqual({ spentPct: 0, committedPct: 0, freePct: 0, budgetMarkerPct: null });
    expect(Number.isNaN(result.spentPct)).toBe(false);
    expect(Number.isNaN(result.committedPct)).toBe(false);
    expect(Number.isNaN(result.freePct)).toBe(false);
  });

  it("never produces NaN even with a negative expected income", () => {
    const result = safeToSpendSegments({
      expected_income_minor: -1,
      spent_mtd_minor: 10_000,
      committed_remaining_minor: 5_000,
      displayed_safe_minor: -15_000,
      monthly_budget_minor: 5_000,
    });

    expect(Number.isNaN(result.spentPct)).toBe(false);
    expect(Number.isNaN(result.committedPct)).toBe(false);
    expect(Number.isNaN(result.freePct)).toBe(false);
    expect(result.budgetMarkerPct).toBeNull();
  });

  it("treats an all-zero month (nothing spent, nothing committed, no income) as an empty bar", () => {
    const result = safeToSpendSegments({
      expected_income_minor: 0,
      spent_mtd_minor: 0,
      committed_remaining_minor: 0,
      displayed_safe_minor: 0,
      monthly_budget_minor: null,
    });

    expect(result).toEqual({ spentPct: 0, committedPct: 0, freePct: 0, budgetMarkerPct: null });
  });
});
