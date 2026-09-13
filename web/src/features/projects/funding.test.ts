import { describe, expect, it } from "vitest";
import { fundingProgress } from "./funding";

describe("fundingProgress", () => {
  it("computes the actual percentage of the target", () => {
    expect(fundingProgress(5000, 10000)).toEqual({
      percent: 50,
      targetReached: false,
      overTarget: false,
      hasTarget: true,
    });
  });

  it("is not reached while actual is below target", () => {
    expect(fundingProgress(9999, 10000).targetReached).toBe(false);
  });

  it("is reached (but not over) exactly at actual === target", () => {
    const result = fundingProgress(10000, 10000);
    expect(result.targetReached).toBe(true);
    expect(result.overTarget).toBe(false);
    expect(result.percent).toBe(100);
  });

  it("is reached, over target, and clamps percent at 100 when actual exceeds target", () => {
    const result = fundingProgress(15000, 10000);
    expect(result.targetReached).toBe(true);
    expect(result.overTarget).toBe(true);
    expect(result.percent).toBe(100);
  });

  it("reports no target (rather than dividing by zero) when target is null", () => {
    expect(fundingProgress(5000, null)).toEqual({
      percent: 0,
      targetReached: false,
      overTarget: false,
      hasTarget: false,
    });
  });

  it("reports no target when target is zero", () => {
    expect(fundingProgress(0, 0)).toEqual({
      percent: 0,
      targetReached: false,
      overTarget: false,
      hasTarget: false,
    });
  });

  it("is 0% and not reached when nothing is funded yet", () => {
    expect(fundingProgress(0, 10000)).toEqual({
      percent: 0,
      targetReached: false,
      overTarget: false,
      hasTarget: true,
    });
  });
});
