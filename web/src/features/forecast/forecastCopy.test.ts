import { describe, expect, it } from "vitest";
import {
  biggestCardBillLabel,
  breakdownRows,
  defaultBreakdownDate,
  findPointByDate,
  monthDeltaMinor,
} from "./forecastCopy";
import type { ProjectionComponents, ProjectionPoint } from "./useForecast";

const COMPONENTS: ProjectionComponents = {
  income_minor: 300_000,
  subscriptions_minor: 5_000,
  loans_minor: 20_000,
  card_bills_minor: 15_000,
  variable_minor: 10_000,
};

function buildPoint(overrides: Partial<ProjectionPoint> = {}): ProjectionPoint {
  return {
    date: "2026-11-30",
    optimistic_minor: 260_000,
    realistic_minor: 250_000,
    components: COMPONENTS,
    card_bill_labels: [{ label: "Nubank", amount_minor: 15_000 }],
    ...overrides,
  };
}

describe("findPointByDate", () => {
  it("returns the point whose date matches", () => {
    const points = [buildPoint({ date: "2026-11-30" }), buildPoint({ date: "2026-12-31" })];
    expect(findPointByDate(points, "2026-12-31")?.date).toBe("2026-12-31");
  });

  it("returns undefined when no point matches (e.g. the dip is today's seeded balance)", () => {
    const points = [buildPoint({ date: "2026-11-30" })];
    expect(findPointByDate(points, "2026-10-15")).toBeUndefined();
  });
});

describe("biggestCardBillLabel", () => {
  it("returns undefined for an empty list", () => {
    expect(biggestCardBillLabel([])).toBeUndefined();
  });

  it("picks the label with the largest amount", () => {
    const labels = [
      { label: "Nubank", amount_minor: 15_000 },
      { label: "BTG", amount_minor: 42_000 },
      { label: "Inter", amount_minor: 1_000 },
    ];
    expect(biggestCardBillLabel(labels)?.label).toBe("BTG");
  });
});

describe("defaultBreakdownDate", () => {
  it("defaults to the lowest-point month when it is one of the projected points", () => {
    const points = [buildPoint({ date: "2026-11-30" }), buildPoint({ date: "2026-12-31" })];
    expect(defaultBreakdownDate(points, "2026-12-31")).toBe("2026-12-31");
  });

  it("falls back to the first projected month when the lowest point isn't one of them", () => {
    const points = [buildPoint({ date: "2026-11-30" }), buildPoint({ date: "2026-12-31" })];
    expect(defaultBreakdownDate(points, "2026-10-15")).toBe("2026-11-30");
  });

  it("returns undefined when there are no points at all", () => {
    expect(defaultBreakdownDate([], "2026-10-15")).toBeUndefined();
  });
});

describe("breakdownRows", () => {
  it("lists every non-zero component, expands card bill labels, and reconciles to realistic_minor", () => {
    const point = buildPoint();
    const rows = breakdownRows(point.components, point.card_bill_labels, 6);

    expect(rows.map((row) => row.key)).toEqual(["income", "subscriptions", "loans", "card-bill-0", "variable"]);
    expect(rows.find((row) => row.key === "income")).toMatchObject({
      label: "renda",
      minor: 300_000,
      tone: "positive",
    });
    expect(rows.find((row) => row.key === "card-bill-0")).toMatchObject({
      label: "fatura Nubank",
      minor: 15_000,
      tone: "negative",
    });
    const variableRow = rows.find((row) => row.key === "variable");
    expect(variableRow).toMatchObject({ label: "variável médio", minor: 10_000, tone: "negative" });
    expect(variableRow?.caption).toBe("média de 6 meses");

    // income − subscriptions − loans − card bills − variable === this
    // fixture's realistic_minor (250_000) — the rows fully account for the
    // displayed saldo.
    const net = rows.reduce(
      (sum, row) => sum + (row.tone === "positive" ? row.minor : -row.minor),
      0,
    );
    expect(net).toBe(point.realistic_minor);
  });

  it("singularizes the lookback caption for a single month", () => {
    const point = buildPoint();
    const rows = breakdownRows(point.components, point.card_bill_labels, 1);
    expect(rows.find((row) => row.key === "variable")?.caption).toBe("média de 1 mês");
  });

  it("omits a zero-amount component entirely", () => {
    const components: ProjectionComponents = { ...COMPONENTS, loans_minor: 0 };
    const rows = breakdownRows(components, [], 6);
    expect(rows.some((row) => row.key === "loans")).toBe(false);
  });

  it("falls back to a single aggregate fatura row when card bills have no labels", () => {
    const rows = breakdownRows(COMPONENTS, [], 6);
    expect(rows.find((row) => row.key === "card-bills")).toMatchObject({
      label: "fatura",
      minor: 15_000,
      tone: "negative",
    });
  });

  it("omits the card-bills row entirely when there is no bill at all", () => {
    const components: ProjectionComponents = { ...COMPONENTS, card_bills_minor: 0 };
    const rows = breakdownRows(components, [], 6);
    expect(rows.some((row) => row.key.startsWith("card-bill"))).toBe(false);
  });

  it("expands every card bill label as its own row when there is more than one card", () => {
    const labels = [
      { label: "Nubank", amount_minor: 10_000 },
      { label: "BTG", amount_minor: 5_000 },
    ];
    const rows = breakdownRows({ ...COMPONENTS, card_bills_minor: 15_000 }, labels, 6);
    expect(rows.filter((row) => row.key.startsWith("card-bill")).map((row) => row.label)).toEqual([
      "fatura Nubank",
      "fatura BTG",
    ]);
  });
});

describe("monthDeltaMinor", () => {
  it("sums the signed rows — the month's own net change, nothing else", () => {
    const point = buildPoint();
    const rows = breakdownRows(point.components, point.card_bill_labels, 6);
    // income (+300_000) − subscriptions (5_000) − loans (20_000)
    // − card bill (15_000) − variable (10_000)
    expect(monthDeltaMinor(rows)).toBe(250_000);
  });

  it("is independent of realistic_minor — the running balance it must NOT be derived from", () => {
    const point = buildPoint({ realistic_minor: 999_999 });
    const rows = breakdownRows(point.components, point.card_bill_labels, 6);
    expect(monthDeltaMinor(rows)).toBe(250_000);
  });

  it("omits a zeroed-out component the same way the rendered rows do", () => {
    const components = { ...COMPONENTS, loans_minor: 0 };
    const rows = breakdownRows(components, [], 6);
    // income (+300_000) − subscriptions (5_000) − card bills (15_000)
    // − variable (10_000); no loans row to subtract.
    expect(monthDeltaMinor(rows)).toBe(270_000);
  });
});
