import { describe, expect, it } from "vitest";
import { describeGoalEta, goalRingProgress } from "./goalProgress";

describe("goalRingProgress", () => {
  it("computes the clamped percent and reached flag for a partial goal", () => {
    expect(goalRingProgress(2_500)).toEqual({ percent: 25, reached: false });
  });

  it("clamps a past-target percent to 100 but still reports reached", () => {
    expect(goalRingProgress(15_000)).toEqual({ percent: 100, reached: true });
  });

  it("reports reached exactly at 100%", () => {
    expect(goalRingProgress(10_000)).toEqual({ percent: 100, reached: true });
  });

  it("clamps a negative pctBps to 0", () => {
    expect(goalRingProgress(-500)).toEqual({ percent: 0, reached: false });
  });
});

describe("describeGoalEta", () => {
  it("reports 'Goal reached' once reached, regardless of the eta payload", () => {
    expect(describeGoalEta(true, { reached_on: null, on_track: false })).toBe("Goal reached");
  });

  it("reports the projected month when on track", () => {
    const line = describeGoalEta(false, { reached_on: "2026-12-31", on_track: true });
    expect(line).toBe("On track — by Dec 2026");
  });

  it("reports 'not on track' when the forecast never reaches the target", () => {
    const line = describeGoalEta(false, { reached_on: null, on_track: false });
    expect(line).toBe("Not on track within 6 months");
  });
});
