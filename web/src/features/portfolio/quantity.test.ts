import { describe, expect, it } from "vitest";
import { formatQuantity, parseQuantity } from "./quantity";

describe("formatQuantity", () => {
  it("trims trailing zeros after the decimal point", () => {
    expect(formatQuantity("12.50000000")).toBe("12.5");
  });

  it("drops the decimal point entirely for a whole quantity", () => {
    expect(formatQuantity("100.00000000")).toBe("100");
  });

  it("preserves full precision for a tiny fractional quantity", () => {
    expect(formatQuantity("0.00000001")).toBe("0.00000001");
  });

  it("leaves an already-trimmed value unchanged", () => {
    expect(formatQuantity("3.25")).toBe("3.25");
  });

  it("returns a non-numeric string as-is (defensive, never throws)", () => {
    expect(formatQuantity("not-a-number")).toBe("not-a-number");
  });
});

describe("parseQuantity", () => {
  it("accepts a plain decimal and returns the trimmed string", () => {
    expect(parseQuantity("12.5")).toBe("12.5");
    expect(parseQuantity(" 100 ")).toBe("100");
  });

  it("accepts a tiny fractional quantity", () => {
    expect(parseQuantity("0.00000001")).toBe("0.00000001");
  });

  it("rejects empty, non-numeric, or non-positive input", () => {
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity(".")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
    expect(parseQuantity("-5")).toBeNull();
    expect(parseQuantity("0")).toBeNull();
  });
});
