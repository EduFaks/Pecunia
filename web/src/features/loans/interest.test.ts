import { describe, expect, it } from "vitest";
import { bpsToPct, bpsToPctInput, pctToBps } from "./interest";

describe("pctToBps", () => {
  it("converts a percent to basis points (1% = 100 bps)", () => {
    expect(pctToBps(5)).toBe(500);
    expect(pctToBps("4.25")).toBe(425);
    expect(pctToBps(0)).toBe(0);
  });

  it("rounds to the nearest integer bps", () => {
    expect(pctToBps("4.255")).toBe(426); // 425.5 → 426
    expect(pctToBps("4.254")).toBe(425); // 425.4 → 425
  });

  it("returns null for empty/blank/non-numeric input", () => {
    expect(pctToBps("")).toBeNull();
    expect(pctToBps("   ")).toBeNull();
    expect(pctToBps("abc")).toBeNull();
    expect(pctToBps(null)).toBeNull();
  });
});

describe("bpsToPct", () => {
  it("converts basis points to a percent (round-trips pctToBps)", () => {
    expect(bpsToPct(500)).toBe(5);
    expect(bpsToPct(425)).toBe(4.25);
    expect(bpsToPct(0)).toBe(0);
  });

  it("returns null when no rate is stored", () => {
    expect(bpsToPct(null)).toBeNull();
  });
});

describe("bpsToPctInput", () => {
  it("renders a prefill string, dropping a trailing .0", () => {
    expect(bpsToPctInput(500)).toBe("5");
    expect(bpsToPctInput(425)).toBe("4.25");
  });

  it("is an empty string when no rate is stored", () => {
    expect(bpsToPctInput(null)).toBe("");
  });
});
