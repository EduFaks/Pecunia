import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompositionTooltipContent, NetWorthComposition } from "./NetWorthComposition";
import type { CompositionPoint } from "./useAnalytics";

const POINTS: CompositionPoint[] = [
  {
    period_start: "2026-01-01",
    cash_minor: 100000,
    assets_minor: 50000,
    investments_minor: 20000,
    debts_minor: -30000,
  },
  {
    period_start: "2026-02-01",
    cash_minor: 110000,
    assets_minor: 55000,
    investments_minor: 25000,
    debts_minor: -20000,
  },
];

describe("NetWorthComposition", () => {
  it("renders four stacked area series (cash, assets, investments, debts) with a zero reference line and a legend", () => {
    const { container } = render(
      <NetWorthComposition points={POINTS} currency="USD" empty={<p>empty</p>} />,
    );

    // A labeled figure carries the summary the SVG can't convey.
    expect(screen.getByRole("img", { name: /net worth composition/i })).toBeInTheDocument();
    // One Recharts <Area> per component — cash, assets, investments, debts.
    expect(container.querySelectorAll(".recharts-area")).toHaveLength(4);
    // The zero baseline separating positive bands from the debts band below.
    expect(container.querySelector(".recharts-reference-line")).not.toBeNull();
    // The legend names every band (identity never lives in color alone).
    for (const label of ["Cash", "Assets", "Investments", "Debts"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("draws debts below the zero axis on its own stack, positives above on theirs", () => {
    const { container } = render(
      <NetWorthComposition points={POINTS} currency="USD" empty={<p>empty</p>} />,
    );

    // The zero baseline's pixel y (SVG y grows downward: below zero = larger y).
    const zeroLine = container.querySelector(".recharts-reference-line line");
    expect(zeroLine).not.toBeNull();
    const zeroY = Number(zeroLine!.getAttribute("y1"));
    expect(Number.isFinite(zeroY)).toBe(true);

    // All y pixel coordinates in a band's area path, found by its fill token.
    function areaYs(key: string): number[] {
      const path = Array.from(
        container.querySelectorAll<SVGPathElement>("path.recharts-area-area"),
      ).find((p) => p.getAttribute("fill") === `var(--color-${key})`);
      expect(path, `area path for ${key}`).toBeDefined();
      const d = path!.getAttribute("d") ?? "";
      return Array.from(d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g), (m) => Number(m[2]));
    }

    // The debts band hangs entirely at-or-below the axis and genuinely extends
    // below it — on the old shared stack it sat above zero, carving a notch out
    // of the top positive band (a gross silhouette, not net).
    const debtYs = areaYs("debts_minor");
    expect(Math.min(...debtYs)).toBeGreaterThanOrEqual(zeroY - 0.5);
    expect(Math.max(...debtYs)).toBeGreaterThan(zeroY + 1);

    // The three positive bands stay entirely at-or-above the axis.
    for (const key of ["cash_minor", "assets_minor", "investments_minor"]) {
      const ys = areaYs(key);
      expect(Math.max(...ys)).toBeLessThanOrEqual(zeroY + 0.5);
    }
  });

  it("shows each part and the summed net total in the tooltip", () => {
    render(
      <CompositionTooltipContent
        active
        currency="USD"
        label="2026-02-01"
        payload={[
          { dataKey: "cash_minor", value: 110000, color: "var(--chart-1)", payload: POINTS[1] },
          { dataKey: "assets_minor", value: 55000, color: "var(--chart-2)", payload: POINTS[1] },
          {
            dataKey: "investments_minor",
            value: 25000,
            color: "var(--chart-3)",
            payload: POINTS[1],
          },
          {
            dataKey: "debts_minor",
            value: -20000,
            color: "var(--pc-negative)",
            payload: POINTS[1],
          },
        ]}
      />,
    );

    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("Debts")).toBeInTheDocument();
    // Net total is the signed sum of the four: 110000 + 55000 + 25000 − 20000 = 170000.
    expect(screen.getByText(/net/i)).toBeInTheDocument();
    expect(screen.getByText("$1,700.00")).toBeInTheDocument();
  });

  it("renders the empty state (never a chart of nothing) when the series is empty", () => {
    render(<NetWorthComposition points={[]} currency="USD" empty={<p>no composition</p>} />);

    expect(screen.getByText("no composition")).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /net worth composition/i }),
    ).not.toBeInTheDocument();
  });
});
