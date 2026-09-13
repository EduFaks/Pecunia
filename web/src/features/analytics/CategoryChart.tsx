import { Cell, Pie, PieChart } from "recharts";
import { describeBreakdown } from "../../components/charts/chartMath";
import type { DonutDatum } from "../../components/charts/chartMath";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import { formatMoney } from "../../lib/money";

/** The neutral token that paints the "Uncategorized" pie slice + legend swatch
 * — a muted grey (not a category hue) that still reads on the near-black
 * ground. Category slices carry their own stored color (the sanctioned
 * raw-color exception, §9); this covers the one bucket that has none. */
export const UNCATEGORIZED_COLOR = "var(--pc-text-faint)";

/**
 * Spending by category — a Recharts `PieChart` donut whose slices carry each
 * category's own stored (vibrant) color; the "Uncategorized" bucket falls back
 * to a neutral token. Beside it, a name+amount legend lists every slice in the
 * response's descending-spend order (identity never color-alone). Slices are
 * separated by a card-colored ring and carry no entrance animation.
 *
 * Shared by the dashboard's headline "Spending by category" graph and the
 * Insights screen's period-scoped breakdown, so both read the one donut idiom.
 * Callers pass a positive-only breakdown (a zero-spend bucket has no wedge).
 */
export function CategoryChart({
  data,
  currency,
  locale,
}: {
  data: DonutDatum[];
  currency: string;
  locale?: string;
}) {
  const pieData = data.map((datum) => ({ ...datum, fill: datum.color ?? UNCATEGORIZED_COLOR }));
  const config: ChartConfig = Object.fromEntries(
    pieData.map((datum) => [datum.key, { label: datum.label, color: datum.fill }]),
  );
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[10rem_1fr]">
      <ChartContainer
        config={config}
        className="mx-auto h-40 w-full max-w-[10rem]"
        role="img"
        aria-label={describeBreakdown(data, currency, locale)}
      >
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideLabel
                valueFormatter={(value) => formatMoney(Number(value), currency, locale)}
              />
            }
          />
          <Pie
            data={pieData}
            dataKey="valueMinor"
            nameKey="label"
            innerRadius="58%"
            outerRadius="92%"
            stroke="var(--pc-surface-1)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {pieData.map((datum) => (
              <Cell key={datum.key} fill={datum.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>

      <ul aria-label="Spending by category" className="flex flex-col gap-2 text-sm">
        {data.map((datum) => (
          <li key={datum.key} className="flex items-center justify-between gap-3">
            <span className="inline-flex min-w-0 items-center gap-2 text-ink-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: datum.color ?? UNCATEGORIZED_COLOR }}
              />
              <span className="truncate">{datum.label}</span>
            </span>
            <span className="shrink-0 font-mono tabular-figures text-ink">
              {formatMoney(datum.valueMinor, currency, locale)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
