import { describe, expect, it } from "vitest";
import { debtPayoffFraction } from "./debtPayoff";

describe("debtPayoffFraction", () => {
  it("is 1 (full) when there is nothing left to pay (payments_left === 0)", () => {
    expect(debtPayoffFraction(0)).toBe(1);
  });

  it("is 1 (full) when the very next payment finishes it off", () => {
    expect(debtPayoffFraction(1)).toBe(1);
  });

  it("is the reciprocal of payments_left otherwise", () => {
    expect(debtPayoffFraction(4)).toBeCloseTo(0.25);
    expect(debtPayoffFraction(24)).toBeCloseTo(1 / 24);
  });
});
