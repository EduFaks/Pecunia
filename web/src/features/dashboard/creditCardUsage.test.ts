import { describe, expect, it } from "vitest";
import { creditCardUsage } from "./creditCardUsage";

describe("creditCardUsage", () => {
  it("computes the used percentage from the outstanding balance's magnitude", () => {
    expect(creditCardUsage(-125_000, 500_000)).toEqual({ percent: 25, overLimit: false });
  });

  it("clamps the percentage at 100 and flags overLimit once the balance exceeds the limit", () => {
    expect(creditCardUsage(-600_000, 500_000)).toEqual({ percent: 100, overLimit: true });
  });

  it("returns null when there is no credit limit on file", () => {
    expect(creditCardUsage(-5_000, null)).toBeNull();
  });

  it("returns null for a non-positive credit limit", () => {
    expect(creditCardUsage(-5_000, 0)).toBeNull();
  });

  it("treats a zero balance as 0% used", () => {
    expect(creditCardUsage(0, 500_000)).toEqual({ percent: 0, overLimit: false });
  });
});
