import type { ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { describeForecast, mergeForecastSeries } from "../../components/charts/chartMath";
import type { ChartPoint, ForecastChartPoint } from "../../components/charts/chartMath";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import { formatMoney, minorUnitFactor } from "../../lib/money";

/** Month-and-year axis/tooltip label from an ISO month-end date, read in UTC
 * so it doesn't drift with the viewer's timezone (matches every other chart
 * here, e.g. `NetWorthComposition`'s `monthLabel`). */
function monthLabel(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** A compact money axis tick ($1.2k, ¥3M) from integer minor units — same
 * move every other chart's Y axis makes. */
function compactMoney(minor: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / minorUnitFactor(currency, locale));
}

const METRIC_LABEL: Record<"cash" | "net_worth", string> = {
  cash: "Cash forecast",
  net_worth: "Net worth",
};

/** Both lines share the one neutral balance color (`--pc-text`) — a forecast
 * is a level over time, not value movement, so it stays out of the semantic
 * emerald/coral pair (§9.1) the same way the dashboard's plain net-worth line
 * already does. */
const forecastConfig = {
  historyValue: { label: "History", color: "var(--pc-text)" },
  projectedValue: { label: "Projected", color: "var(--pc-text)" },
} satisfies ChartConfig;

export interface ForecastAreaData {
  /** Real, already-happened points — drawn as a solid line. Empty for a
   * forward-only chart (the Insights cash-forecast card has no historical
   * cash-balance series to draw from). */
  history: ChartPoint[];
  /** Future points from `/analytics/forecast` — drawn as a dashed line with
   * a shaded `lower..upper` uncertainty band. */
  projected: ForecastChartPoint[];
}

/**
 * The shared "solid history -> dashed projection" treatment (v1.4 Track O):
 * a Recharts `ComposedChart` with a solid `<Line>` over real history, a
 * **dashed** `<Line>` over the projected tail (bridged onto history's last
 * point so it connects with no gap — see `mergeForecastSeries`), and a
 * shaded `<Area>` for the `lower..upper` uncertainty band around the
 * projected line. `metric="cash"` additionally draws a zero `<ReferenceLine>`
 * flagging a balance going negative; `net_worth` does not (a net-worth level
 * going negative is unremarkable — it's the ordinary state of being in debt).
 *
 * Entrance animation is off (reduced-motion-safe + deterministic tests); the
 * labeled `role="img"` figure carries a one-sentence summary for assistive
 * tech — `ariaLabel` lets a caller override the default (`describeForecast`)
 * with a richer one (e.g. the dashboard's net-worth card keeps its existing
 * trend-based summary via `describeTrend`). A chart with neither history nor
 * a projection shows `empty` — never a chart of nothing (the dataviz
 * constraint).
 */
export function ForecastArea({
  data,
  metric,
  currency,
  locale,
  ariaLabel,
  empty,
}: {
  data: ForecastAreaData;
  metric: "cash" | "net_worth";
  currency: string;
  locale?: string;
  ariaLabel?: string;
  empty: ReactNode;
}) {
  const { history, projected } = data;
  if (history.length === 0 && projected.length === 0) {
    return <>{empty}</>;
  }

  const merged = mergeForecastSeries(history, projected);
  const summary = ariaLabel ?? describeForecast(METRIC_LABEL[metric], projected, currency, locale);

  return (
    <ChartContainer config={forecastConfig} className="h-64 w-full" role="img" aria-label={summary}>
      <ComposedChart data={merged} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value) => monthLabel(String(value), locale)}
        />
        <YAxis
          width={56}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => compactMoney(Number(value), currency, locale)}
        />
        {metric === "cash" ? <ReferenceLine y={0} /> : null}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => monthLabel(String(value), locale)}
              valueFormatter={(value) => formatMoney(Number(value), currency, locale)}
            />
          }
        />
        {projected.length > 0 ? (
          <>
            {/* The Recharts range-band trick: an invisible `lower` area
                stacked under a visible `bandWidth` area, so the visible
                band's top lands at lower+bandWidth == upper. Only rendered
                when there's a projection to band. */}
            <Area
              dataKey="lower"
              stackId="band"
              stroke="none"
              fill="transparent"
              isAnimationActive={false}
              legendType="none"
            />
            <Area
              dataKey="bandWidth"
              stackId="band"
              stroke="none"
              fill="var(--pc-text)"
              fillOpacity={0.08}
              isAnimationActive={false}
              legendType="none"
            />
          </>
        ) : null}
        <Line
          dataKey="historyValue"
          type="monotone"
          stroke="var(--color-historyValue)"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
          connectNulls={false}
        />
        <Line
          dataKey="projectedValue"
          type="monotone"
          stroke="var(--color-projectedValue)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
          connectNulls={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
