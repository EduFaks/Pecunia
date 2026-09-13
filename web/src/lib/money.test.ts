import { describe, expect, it } from "vitest";
import { formatMoney, minorUnitFactor, parseMoney } from "./money";

describe("minorUnitFactor", () => {
  it("is 100 for a 2-decimal currency (USD)", () => {
    expect(minorUnitFactor("USD")).toBe(100);
  });

  it("is 1 for a 0-decimal currency (JPY)", () => {
    expect(minorUnitFactor("JPY")).toBe(1);
  });

  it("is 1000 for a 3-decimal currency (BHD)", () => {
    expect(minorUnitFactor("BHD")).toBe(1000);
  });
});

describe("formatMoney", () => {
  it("formats a 2-decimal currency (BRL) by dividing minor units by 100", () => {
    // 100000 minor units / 100 = R$ 1.000,00
    expect(formatMoney(100000, "BRL", "pt-BR")).toContain("1.000,00");
  });

  it("renders negative amounts with a negative sign, not just abs value", () => {
    // -849900 minor units / 100 = -R$ 8.499,00
    const result = formatMoney(-849900, "BRL", "pt-BR");
    expect(result).toContain("8.499,00");
    expect(result).toMatch(/-/);
  });

  it("formats a 0-decimal currency (JPY) with no fractional digits, factor 1", () => {
    // JPY has no minor unit subdivision in ISO 4217 (minimumFractionDigits: 0),
    // so 1000 minor units is 1000 yen, not 10 yen.
    const result = formatMoney(1000, "JPY", "ja-JP");
    // ja-JP uses "." as its decimal separator and "," for grouping, so an
    // absent "." here means no fractional digits were rendered at all.
    expect(result).not.toContain(".");
    expect(result).toContain("1,000");
  });

  it("formats a 3-decimal currency (BHD) by dividing minor units by 1000", () => {
    // BHD has 3 minor-unit digits: 1234567 minor / 1000 = 1234.567 BHD
    const result = formatMoney(1234567, "BHD", "en-US");
    expect(result).toContain("1,234.567");
  });

  it("formats zero", () => {
    expect(formatMoney(0, "USD", "en-US")).toContain("0.00");
  });
});

describe("parseMoney", () => {
  it("round-trips a formatted 2-decimal amount (USD) back to minor units", () => {
    const formatted = formatMoney(184999, "USD", "en-US");
    expect(parseMoney(formatted, "USD", "en-US")).toBe(184999);
  });

  it("round-trips a formatted 0-decimal amount (JPY) back to minor units", () => {
    const formatted = formatMoney(2500, "JPY", "ja-JP");
    expect(parseMoney(formatted, "JPY", "ja-JP")).toBe(2500);
  });

  it("round-trips a negative amount (BRL, pt-BR grouping/decimal separators)", () => {
    const formatted = formatMoney(-849900, "BRL", "pt-BR");
    expect(parseMoney(formatted, "BRL", "pt-BR")).toBe(-849900);
  });
});
