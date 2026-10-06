import type { ReactNode } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import { formatMoney, minorUnitFactor } from "../../lib/money";
import type { ProjectionPoint } from "./useForecast";

/** Month-and-year axis/tooltip label from an ISO month-end date, read in UTC
 * so it doesn't drift with the viewer's timezone (matches every other chart
 * here, e.g. `ForecastArea`'s own `monthLabel`). */
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

/** `realistic_minor` is the headline line (solid, full `--pc-text`);
 * `optimistic_minor` is the best-case line (dashed, the dimmer
 * `--pc-text-secondary` — "lighter" as in less emphasized, not brighter),
 * same visual-hierarchy idiom `ForecastArea` uses for its solid/dashed pair,
 * here extended to two genuinely different series rather than one series
 * split across a history/projected boundary. */
const projectionConfig = {
  realistic_minor: { label: "Realista", color: "var(--pc-text)" },
  optimistic_minor: { label: "Otimista", color: "var(--pc-text-secondary)" },
} satisfies ChartConfig;

export interface ProjectionChartProps {
  /** The horizon's month-end points, oldest first — `ProjectionPoint`,
   * mirrored verbatim from `/analytics/projection` (same "pass the API
   * points array straight to Recharts" convention `NetWorthComposition`
   * uses). */
  points: ProjectionPoint[];
  /** `Projection.lowest_point` — always marked with a reference dot, read off
   * the realistic line (may land on today's actual balance rather than any
   * plotted point, if today is already the series' minimum — the dot simply
   * doesn't render when its date isn't one of `points`' own x-axis values). */
  lowestPoint: { value_minor: number; date: string };
  /** `Projection.recovery` — marked with a second reference dot when the
   * realistic line climbs back to zero or above within the horizon; omitted
   * entirely when `null` (never recovered yet). */
  recovery: { date: string; value_minor: number } | null;
  currency: string;
  locale?: string;
  empty: ReactNode;
}

/**
 * The forecast tab's headline chart (Track V): a Recharts `ComposedChart`
 * with two full lines over the SAME horizon — `realistic_minor` solid,
 * `optimistic_minor` dashed and dimmer — plus a permanent zero
 * `ReferenceLine` (unlike `ForecastArea`'s cash-only conditional one, this
 * chart is always a cash balance that can go negative) and a `ReferenceDot`
 * on the lowest-point and recovery dates. Entrance animation is off
 * (reduced-motion-safe + deterministic tests); the labeled `role="img"`
 * figure carries a one-sentence summary for assistive tech. No points at all
 * shows `empty` — never a chart of nothing (the dataviz constraint).
 */
export function ProjectionChart({
  points,
  lowestPoint,
  recovery,
  currency,
  locale,
  empty,
}: ProjectionChartProps) {
  if (points.length === 0) {
    return <>{empty}</>;
  }

  const last = points[points.length - 1];
  const summary = `Cash projection: realistic ${formatMoney(last.realistic_minor, currency, locale)}, optimistic ${formatMoney(last.optimistic_minor, currency, locale)} by ${monthLabel(last.date, locale)}.`;

  return (
    <ChartContainer config={projectionConfig} className="h-64 w-full" role="img" aria-label={summary}>
      <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
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
        <ReferenceLine y={0} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => monthLabel(String(value), locale)}
              valueFormatter={(value) => formatMoney(Number(value), currency, locale)}
            />
          }
        />
        <Line
          dataKey="optimistic_minor"
          type="monotone"
          stroke="var(--color-optimistic_minor)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
        />
        <Line
          dataKey="realistic_minor"
          type="monotone"
          stroke="var(--color-realistic_minor)"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
        />
        <ReferenceDot
          x={lowestPoint.date}
          y={lowestPoint.value_minor}
          r={4}
          fill="var(--pc-negative)"
          stroke="none"
          isFront
        />
        {recovery ? (
          <ReferenceDot
            x={recovery.date}
            y={recovery.value_minor}
            r={4}
            fill="var(--pc-positive)"
            stroke="none"
            isFront
          />
        ) : null}
      </ComposedChart>
    </ChartContainer>
  );
}

export default ProjectionChart;
