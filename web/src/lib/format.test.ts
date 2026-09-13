import { describe, expect, it } from "vitest";
import { formatDate, formatNumber, formatRelativeDate } from "./format";

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

describe("formatRelativeDate", () => {
  const NOW = new Date("2026-06-10T12:00:00.000Z");

  it("returns 'today' for the current UTC day", () => {
    expect(formatRelativeDate("2026-06-10", NOW)).toBe("today");
  });

  it("returns 'yesterday' for one day back", () => {
    expect(formatRelativeDate("2026-06-09", NOW)).toBe("yesterday");
  });

  it("returns a day count under a month", () => {
    expect(formatRelativeDate("2026-06-05", NOW)).toBe("5d ago");
  });

  it("returns a month count for a month or more", () => {
    expect(formatRelativeDate("2026-04-10", NOW)).toBe("2mo ago");
  });

  it("returns a year count for a year or more", () => {
    expect(formatRelativeDate("2024-06-10", NOW)).toBe("2y ago");
  });

  it("treats a same-or-future date as 'today' rather than a negative count", () => {
    expect(formatRelativeDate("2026-06-15", NOW)).toBe("today");
  });

  it("throws on an invalid date string", () => {
    expect(() => formatRelativeDate("not-a-date", NOW)).toThrow();
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
