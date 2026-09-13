import { describe, expect, it } from "vitest";
import { payoffProgress } from "./payoff";

describe("payoffProgress", () => {
  it("computes paid/principal as a percentage", () => {
    const progress = payoffProgress(250000, 1000000, 750000);
    expect(progress.percent).toBe(25);
    expect(progress.paidOff).toBe(false);
    expect(progress.hasPrincipal).toBe(true);
  });

  it("reads complete and flags paidOff once remaining is 0", () => {
    const progress = payoffProgress(1000000, 1000000, 0);
    expect(progress.percent).toBe(100);
    expect(progress.paidOff).toBe(true);
  });

  it("clamps an overpaid loan to 100% (remaining floors at 0)", () => {
    const progress = payoffProgress(1200000, 1000000, 0);
    expect(progress.percent).toBe(100);
    expect(progress.paidOff).toBe(true);
  });

  it("has no bar for a loan with no principal", () => {
    const progress = payoffProgress(0, 0, 0);
    expect(progress.hasPrincipal).toBe(false);
    expect(progress.percent).toBe(0);
    expect(progress.paidOff).toBe(false);
  });
});
