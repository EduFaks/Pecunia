import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectionChart } from "./ProjectionChart";
import type { ProjectionPoint } from "./useForecast";

const ZERO_COMPONENTS = {
  income_minor: 300_000,
  subscriptions_minor: 5_000,
  loans_minor: 20_000,
  card_bills_minor: 0,
  variable_minor: 10_000,
};

const POINTS: ProjectionPoint[] = [
  {
    date: "2026-11-30",
    optimistic_minor: 500_000,
    realistic_minor: 40_000,
    components: ZERO_COMPONENTS,
    card_bill_labels: [],
  },
  {
    date: "2026-12-31",
    optimistic_minor: 520_000,
    realistic_minor: -20_000,
    components: ZERO_COMPONENTS,
    card_bill_labels: [],
  },
  {
    date: "2027-01-31",
    optimistic_minor: 540_000,
    realistic_minor: 10_000,
    components: ZERO_COMPONENTS,
    card_bill_labels: [],
  },
];

describe("ProjectionChart", () => {
  it("renders a solid realistic line and a dashed optimistic line", () => {
    const { container } = render(
      <ProjectionChart
        points={POINTS}
        lowestPoint={{ value_minor: -20_000, date: "2026-12-31" }}
        recovery={null}
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

  it("always shows a zero reference line (a cash balance can go negative)", () => {
    const { container } = render(
      <ProjectionChart
        points={POINTS}
        lowestPoint={{ value_minor: -20_000, date: "2026-12-31" }}
        recovery={null}
        currency="USD"
        empty={<p>empty</p>}
      />,
    );

    expect(container.querySelector(".recharts-reference-line")).not.toBeNull();
  });

  it("marks both the lowest point and the recovery date with reference dots", () => {
    const { container } = render(
      <ProjectionChart
        points={POINTS}
        lowestPoint={{ value_minor: -20_000, date: "2026-12-31" }}
        recovery={{ date: "2027-01-31", value_minor: 10_000 }}
        currency="USD"
        empty={<p>empty</p>}
      />,
    );

    expect(container.querySelectorAll(".recharts-reference-dot")).toHaveLength(2);
  });

  it("marks only the lowest point when there is no recovery yet", () => {
    const { container } = render(
      <ProjectionChart
        points={POINTS}
        lowestPoint={{ value_minor: -20_000, date: "2026-12-31" }}
        recovery={null}
        currency="USD"
        empty={<p>empty</p>}
      />,
    );

    expect(container.querySelectorAll(".recharts-reference-dot")).toHaveLength(1);
  });

  it("renders month-and-year x-axis tick labels from the ISO dates", () => {
    render(
      <ProjectionChart
        points={POINTS}
        lowestPoint={{ value_minor: -20_000, date: "2026-12-31" }}
        recovery={null}
        currency="USD"
        locale="en-US"
        empty={<p>empty</p>}
      />,
    );

    expect(screen.getByText("Nov 2026")).toBeInTheDocument();
  });

  it("renders the empty state when there are no points (never a chart of nothing)", () => {
    render(
      <ProjectionChart
        points={[]}
        lowestPoint={{ value_minor: 0, date: "2026-11-30" }}
        recovery={null}
        currency="USD"
        empty={<p>sem dados ainda</p>}
      />,
    );

    expect(screen.getByText("sem dados ainda")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
