import { describe, expect, it } from "vitest";
import { debtPayoffFraction } from "./debtPayoff";

describe("debtPayoffFraction", () => {
  it("is the fraction of principal already paid off (principal - remaining) / principal", () => {
    expect(debtPayoffFraction(1_000, 250)).toBeCloseTo(0.75);
    expect(debtPayoffFraction(4_800_000, 1_200_000)).toBeCloseTo(0.75);
  });

  it("is 0 when nothing has been paid off yet", () => {
    expect(debtPayoffFraction(1_000, 1_000)).toBe(0);
  });

  it("is 1 (full) once the debt is fully paid off", () => {
    expect(debtPayoffFraction(1_000, 0)).toBe(1);
  });

  it("clamps to 0 when principal_minor isn't positive (nothing to divide by)", () => {
    expect(debtPayoffFraction(0, 500)).toBe(0);
    expect(debtPayoffFraction(-100, 500)).toBe(0);
  });

  it("clamps into [0, 1] for an out-of-range remaining (e.g. remaining > principal)", () => {
    expect(debtPayoffFraction(1_000, 1_500)).toBe(0);
  });
});
