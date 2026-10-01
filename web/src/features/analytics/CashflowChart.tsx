import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { describeCashflow } from "../../components/charts/chartMath";
import type { CashflowBar } from "../../components/charts/chartMath";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import { formatMoney, minorUnitFactor } from "../../lib/money";

/** Month-and-year axis/tooltip label from an ISO month start, read in UTC so
 * it doesn't drift with the viewer's timezone (same rationale as `formatDate`,
 * and the near-identical helper in `ForecastArea`/`NetWorthComposition`). */
function monthLabel(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** A compact money axis tick ($1.2k, ¥3M) from integer minor units — full
 * amounts stay on the tooltips (via `formatMoney`); the axis gets the short
 * form so long tick labels don't crowd the plot. Divides by the currency's
 * real minor-unit factor, same as `formatMoney`. */
function compactMoney(minor: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / minorUnitFactor(currency, locale));
}

/** Income vs spend is real value movement, so it keeps the semantic pair:
 * income emerald (`--pc-positive`), spend coral (`--pc-negative`) (§9.1). */
const cashflowConfig = {
  income: { label: "Income", color: "var(--pc-positive)" },
  spend: { label: "Spend", color: "var(--pc-negative)" },
} satisfies ChartConfig;

/** One legend swatch + label — a colored mark carries identity, the text
 * stays in an ink token (dataviz: text never wears the series color). */
function LegendItem({ colorClass, children }: { colorClass: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-2">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${colorClass}`} />
      {children}
    </span>
  );
}

/**
 * Income vs spend — a Recharts `BarChart` with two bars per month, income
 * (emerald) beside spend (coral). A small token-driven legend names both
 * series (identity is never color-alone) and the tooltip formats money via
 * `formatMoney`. Bars carry no entrance animation (reduced-motion-safe +
 * deterministic tests). Extracted from the pre-Track-U Dashboard (it now
 * lives on the Insights screen, alongside the dashboard's leaner
 * `SpendingBreakdownCard`, which shares the same category data but not this
 * chart).
 */
export function CashflowChart({
  bars,
  currency,
  locale,
}: {
  bars: CashflowBar[];
  currency: string;
  locale?: string;
}) {
  const data = bars.map((bar) => ({
    period: bar.periodStart,
    income: bar.incomeMinor,
    spend: bar.spendMinor,
  }));
  return (
    <div className="w-full">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <LegendItem colorClass="bg-positive">Income</LegendItem>
        <LegendItem colorClass="bg-negative">Spend</LegendItem>
      </div>
      <ChartContainer
        config={cashflowConfig}
        className="h-56 w-full"
        role="img"
        aria-label={describeCashflow(bars, currency, locale)}
      >
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="period"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={16}
            tickFormatter={(value) => monthLabel(String(value), locale)}
          />
          <YAxis
            width={56}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => compactMoney(Number(value), currency, locale)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => monthLabel(String(label), locale)}
                valueFormatter={(value) => formatMoney(Number(value), currency, locale)}
              />
            }
          />
          <Bar
            dataKey="income"
            fill="var(--color-income)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
          <Bar
            dataKey="spend"
            fill="var(--color-spend)"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
