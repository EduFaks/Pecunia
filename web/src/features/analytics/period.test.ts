import { describe, expect, it } from "vitest";
import { PERIOD_OPTIONS, computePeriodRange } from "./period";

describe("computePeriodRange", () => {
  it("ends the window at the given day and starts it that many months earlier", () => {
    const range = computePeriodRange(3, new Date("2026-09-12T00:00:00.000Z"));
    expect(range.to).toBe("2026-09-12");
    expect(range.from).toBe("2026-06-12");
  });

  it("narrows the window as the month count shrinks (later `from`, same `to`)", () => {
    const today = new Date("2026-09-12T00:00:00.000Z");
    const twelve = computePeriodRange(12, today);
    const three = computePeriodRange(3, today);
    expect(three.to).toBe(twelve.to);
    expect(three.from > twelve.from).toBe(true); // 3-month window starts later
  });

  it("rolls the year back when subtracting months crosses January", () => {
    const range = computePeriodRange(6, new Date("2026-02-15T00:00:00.000Z"));
    expect(range.from).toBe("2025-08-15");
  });

  it("clamps to the last valid day when the start month is shorter (Mar 31 - 1mo)", () => {
    // Naive month subtraction would land on a non-existent Feb 31; the helper
    // must not roll forward into March.
    const range = computePeriodRange(1, new Date("2026-03-31T00:00:00.000Z"));
    expect(range.from).toBe("2026-02-28");
  });

  it("offers 3-, 6-, 12-, and 24-month options, narrowest first", () => {
    expect(PERIOD_OPTIONS.map((option) => option.months)).toEqual([3, 6, 12, 24]);
  });

  it("reaches a full two years back for the 24-month window", () => {
    const today = new Date("2026-09-12T00:00:00.000Z");
    const twentyFour = computePeriodRange(24, today);
    const twelve = computePeriodRange(12, today);
    expect(twentyFour.from).toBe("2024-09-12");
    expect(twentyFour.from < twelve.from).toBe(true); // wider window starts earlier
  });
});
