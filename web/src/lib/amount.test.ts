import { describe, expect, it } from "vitest";
import { amountToMinor, minorToAmountInput, signedAmountToMinor } from "./amount";

describe("amountToMinor", () => {
  it("maps a typed decimal to integer minor units for a 2-decimal currency", () => {
    // "84.99" USD -> 8499 cents.
    expect(amountToMinor("84.99", "USD")).toBe(8499);
  });

  it("maps a whole-number decimal for a 0-decimal currency (JPY)", () => {
    expect(amountToMinor("1000", "JPY")).toBe(1000);
  });

  it("pads a short fractional part out to the currency's digit count", () => {
    // "5.4" USD -> 540 cents, not 54.
    expect(amountToMinor("5.4", "USD")).toBe(540);
  });

  it("rounds half-up when more fractional digits are typed than the currency supports", () => {
    expect(amountToMinor("1.005", "USD")).toBe(101);
    expect(amountToMinor("1.004", "USD")).toBe(100);
  });

  it("handles a 3-decimal currency (BHD)", () => {
    expect(amountToMinor("1234.567", "BHD")).toBe(1234567);
  });

  it("treats a bare integer with no decimal point correctly", () => {
    expect(amountToMinor("42", "USD")).toBe(4200);
  });

  it("returns null for empty or non-numeric input", () => {
    expect(amountToMinor("", "USD")).toBeNull();
    expect(amountToMinor("abc", "USD")).toBeNull();
    expect(amountToMinor("-", "USD")).toBeNull();
  });

  it("ignores a leading minus sign — sign is controlled separately by the inflow/outflow toggle", () => {
    expect(amountToMinor("-84.99", "USD")).toBe(8499);
  });
});

describe("minorToAmountInput", () => {
  it("renders an absolute minor amount back as a plain decimal string for editing", () => {
    expect(minorToAmountInput(8499, "USD")).toBe("84.99");
    expect(minorToAmountInput(1000, "JPY")).toBe("1000");
    expect(minorToAmountInput(1234567, "BHD")).toBe("1234.567");
  });

  it("drops the sign — the amount input is always non-negative, sign lives in the toggle", () => {
    expect(minorToAmountInput(-8499, "USD")).toBe("84.99");
  });

  it("round-trips through amountToMinor", () => {
    expect(amountToMinor(minorToAmountInput(8499, "USD"), "USD")).toBe(8499);
    expect(amountToMinor(minorToAmountInput(1000, "JPY"), "JPY")).toBe(1000);
  });
});

describe("signedAmountToMinor", () => {
  it("keeps a positive amount positive (e.g. a starting balance)", () => {
    expect(signedAmountToMinor("500", "USD")).toBe(50000);
  });

  it("keeps a leading minus sign (e.g. a credit-card balance owed)", () => {
    expect(signedAmountToMinor("-500", "USD")).toBe(-50000);
  });

  it("returns null for invalid input", () => {
    expect(signedAmountToMinor("abc", "USD")).toBeNull();
  });
});
