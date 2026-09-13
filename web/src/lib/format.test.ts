import { describe, expect, it } from "vitest";
import { formatDate, formatNumber } from "./format";

describe("formatDate", () => {
  it("formats an ISO date string using an explicit DD/MM/YYYY dateFormat preference", () => {
    expect(formatDate("2026-09-11T00:00:00.000Z", { dateFormat: "DD/MM/YYYY" })).toBe(
      "11/09/2026",
    );
  });

  it("formats an ISO date string using an explicit MM/DD/YYYY dateFormat preference", () => {
    expect(formatDate("2026-09-11T00:00:00.000Z", { dateFormat: "MM/DD/YYYY" })).toBe(
      "09/11/2026",
    );
  });

  it("formats an ISO date string using an explicit YYYY-MM-DD dateFormat preference", () => {
    expect(formatDate("2026-09-11T00:00:00.000Z", { dateFormat: "YYYY-MM-DD" })).toBe(
      "2026-09-11",
    );
  });

  it("falls back to locale-driven formatting when no dateFormat preference is given", () => {
    const result = formatDate("2026-09-11T00:00:00.000Z", { locale: "en-US" });
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/11/);
  });

  it("throws on an invalid date string", () => {
    expect(() => formatDate("not-a-date")).toThrow();
  });
});

describe("formatNumber", () => {
  it("formats a number with locale-appropriate grouping (en-US)", () => {
    expect(formatNumber(1234567.5, "en-US")).toBe("1,234,567.5");
  });

  it("formats a number with locale-appropriate grouping (pt-BR)", () => {
    expect(formatNumber(1234567.5, "pt-BR")).toBe("1.234.567,5");
  });
});
