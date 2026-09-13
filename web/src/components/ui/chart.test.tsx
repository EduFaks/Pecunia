import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Bar, BarChart } from "recharts";
import { ChartContainer, ChartTooltipContent, type ChartConfig } from "./chart";

const config: ChartConfig = {
  revenue: { label: "Revenue", color: "var(--chart-1)" },
};

describe("ChartContainer", () => {
  it("renders a Recharts chart (via the ResponsiveContainer stub) and exposes each config color as a --color-<key> var", () => {
    const { container } = render(
      <ChartContainer config={config}>
        <BarChart data={[{ month: "Jan", revenue: 10 }]}>
          <Bar dataKey="revenue" fill="var(--color-revenue)" />
        </BarChart>
      </ChartContainer>,
    );

    const wrapper = container.querySelector("[data-chart]") as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.getPropertyValue("--color-revenue")).toBe("var(--chart-1)");
    // The stub gives the chart a real size so it paints its SVG in jsdom.
    expect(container.querySelector("svg.recharts-surface")).not.toBeNull();
  });

  it("omits a --color-<key> var for a config entry that has no color", () => {
    const { container } = render(
      <ChartContainer config={{ bare: { label: "Bare" } }}>
        <BarChart data={[]}>
          <Bar dataKey="bare" />
        </BarChart>
      </ChartContainer>,
    );

    const wrapper = container.querySelector("[data-chart]") as HTMLElement;
    expect(wrapper.style.getPropertyValue("--color-bare")).toBe("");
  });
});

describe("ChartTooltipContent", () => {
  it("renders the active payload's label and value", () => {
    render(
      <ChartTooltipContent
        active
        label="January"
        payload={[{ name: "Revenue", value: 1234, dataKey: "revenue", color: "var(--chart-1)" }]}
      />,
    );

    expect(screen.getByText("January")).toBeInTheDocument();
    expect(screen.getByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("1234")).toBeInTheDocument();
  });

  it("renders nothing when inactive or empty", () => {
    const { container } = render(<ChartTooltipContent active={false} payload={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
