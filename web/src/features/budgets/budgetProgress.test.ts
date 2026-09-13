import { describe, expect, it } from "vitest";
import { budgetProgress } from "./budgetProgress";

describe("budgetProgress", () => {
  it("has no actual (and no bar to show) when actualMinor is null — a categoryless budget", () => {
    expect(budgetProgress(null, 60_000)).toEqual({ percent: 0, overBudget: false, hasActual: false });
  });

  it("computes a clamped percent under budget", () => {
    expect(budgetProgress(30_000, 60_000)).toEqual({ percent: 50, overBudget: false, hasActual: true });
  });

  it("flags overBudget once actual exceeds the amount, clamping percent at 100", () => {
    const result = budgetProgress(90_000, 60_000);
    expect(result.overBudget).toBe(true);
    expect(result.percent).toBe(100);
    expect(result.hasActual).toBe(true);
  });

  it("is not overBudget when actual exactly equals amount", () => {
    expect(budgetProgress(60_000, 60_000)).toEqual({ percent: 100, overBudget: false, hasActual: true });
  });

  it("treats a zero amount with any spend as a full, over-budget bar rather than dividing by zero", () => {
    expect(budgetProgress(100, 0)).toEqual({ percent: 100, overBudget: true, hasActual: true });
  });

  it("treats a zero amount with zero spend as an empty, non-over bar", () => {
    expect(budgetProgress(0, 0)).toEqual({ percent: 0, overBudget: false, hasActual: true });
  });
});
