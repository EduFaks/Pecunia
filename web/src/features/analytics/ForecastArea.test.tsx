import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastArea } from "./ForecastArea";
import type { ChartPoint, ForecastChartPoint } from "../../components/charts/chartMath";

const HISTORY: ChartPoint[] = [
  { date: "2026-07-31", valueMinor: 100000 },
  { date: "2026-08-31", valueMinor: 120000 },
];

const PROJECTED: ForecastChartPoint[] = [
  { date: "2026-09-30", valueMinor: 140000, lowerMinor: 130000, upperMinor: 150000 },
  { date: "2026-10-31", valueMinor: 160000, lowerMinor: 140000, upperMinor: 180000 },
];

describe("ForecastArea", () => {
  it("renders a solid history line and a dashed projected line", () => {
    const { container } = render(
      <ForecastArea
        data={{ history: HISTORY, projected: PROJECTED }}
        metric="net_worth"
        currency="USD"
        empty={<p>empty</p>}
      />,
    );

    const lines = container.querySelectorAll(".recharts-line-curve");
    expect(lines.length).toBe(2);
    const dashed = Array.from(lines).filter((line) => line.getAttribute("stroke-dasharray"));
    const solid = Array.from(lines).filter((line) => !line.getAttribute("stroke-dasharray"));
    expect(dashed).toHaveLength(1);
    expect(solid).toHaveLength(1);
  });

  it("renders the lower..upper band as a shaded area when a forecast is projected", () => {
    const { container } = render(
      <ForecastArea
        data={{ history: HISTORY, projected: PROJECTED }}
        metric="net_worth"
        currency="USD"
        empty={<p>empty</p>}
      />,
    );

    expect(container.querySelectorAll(".recharts-area").length).toBeGreaterThan(0);
  });

  it("omits the band when there is nothing projected", () => {
    const { container } = render(
      <ForecastArea
        data={{ history: HISTORY, projected: [] }}
        metric="net_worth"
        currency="USD"
        empty={<p>empty</p>}
      />,
    );

    expect(container.querySelectorAll(".recharts-area")).toHaveLength(0);
  });

  it("shows a zero reference line for the cash metric but not net worth", () => {
    const { container: cashContainer } = render(
      <ForecastArea
        data={{ history: [], projected: PROJECTED }}
        metric="cash"
        currency="USD"
        empty={<p>empty</p>}
      />,
    );
    expect(cashContainer.querySelector(".recharts-reference-line")).not.toBeNull();

    const { container: netWorthContainer } = render(
      <ForecastArea
        data={{ history: HISTORY, projected: PROJECTED }}
        metric="net_worth"
        currency="USD"
        empty={<p>empty</p>}
      />,
    );
    expect(netWorthContainer.querySelector(".recharts-reference-line")).toBeNull();
  });

  it("uses the default forecast summary when no explicit aria-label is given", () => {
    render(
      <ForecastArea
        data={{ history: [], projected: PROJECTED }}
        metric="cash"
        currency="USD"
        locale="en-US"
        empty={<p>empty</p>}
      />,
    );

    expect(screen.getByRole("img", { name: /cash forecast/i })).toBeInTheDocument();
  });

  it("prefers an explicit aria-label when given", () => {
    render(
      <ForecastArea
        data={{ history: HISTORY, projected: PROJECTED }}
        metric="net_worth"
        currency="USD"
        ariaLabel="Custom summary text"
        empty={<p>empty</p>}
      />,
    );

    expect(screen.getByRole("img", { name: "Custom summary text" })).toBeInTheDocument();
  });

  it("renders the empty state (never a chart of nothing) when there is no history and nothing projected", () => {
    render(
      <ForecastArea
        data={{ history: [], projected: [] }}
        metric="cash"
        currency="USD"
        empty={<p>no forecast yet</p>}
      />,
    );

    expect(screen.getByText("no forecast yet")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
