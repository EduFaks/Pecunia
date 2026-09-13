import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import { formatMoney, minorUnitFactor } from "../../lib/money";
import type { CompositionPoint } from "./useAnalytics";

/** The four net-worth ingredients, keyed by their data field so the config
 * doubles as the `--color-<key>` source, the legend labels, and the tooltip
 * labels. The three positive bands take the vibrant `--chart-*` palette
 * (CONVENTIONS §9's sanctioned exception); debts is the one semantic band —
 * coral `--pc-negative` (§9.1) — and rides below the zero axis because its
 * values are signed negative for a net liability. Order here is the stack order
 * (cash at the bottom, up through investments; debts stacks downward). */
const compositionConfig = {
  cash_minor: { label: "Cash", color: "var(--chart-1)" },
  assets_minor: { label: "Assets", color: "var(--chart-2)" },
  investments_minor: { label: "Investments", color: "var(--chart-3)" },
  debts_minor: { label: "Debts", color: "var(--pc-negative)" },
} satisfies ChartConfig;

/** The band dataKeys in stack order — cash/assets/investments climb above zero
 * on the shared `"positive"` stack; debts (signed negative) rides its own
 * `"debt"` stack so it draws downward from the zero baseline instead of
 * carving a notch out of the top positive band. */
const BAND_KEYS = ["cash_minor", "assets_minor", "investments_minor", "debts_minor"] as const;
type BandKey = (typeof BAND_KEYS)[number];

/** Which Recharts stack a band joins — the three positive bands share one so
 * they pile up from zero; debts stacks alone so its negative values render
 * below the zero `ReferenceLine` (assets vs. liabilities, not gross). */
function stackIdOf(key: BandKey): string {
  return key === "debts_minor" ? "debt" : "positive";
}

/** The signed net total of one month — the plain sum of the four bands (debts
 * already carries its sign), i.e. the headline net worth the bands decompose. */
function netOf(point: CompositionPoint): number {
  return point.cash_minor + point.assets_minor + point.investments_minor + point.debts_minor;
}

/** Month-and-year axis/tooltip label from an ISO month start, read in UTC so it
 * doesn't drift with the viewer's timezone (same rationale as `formatDate`). */
function monthLabel(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** A compact money axis tick ($1.2k, ¥3M) from integer minor units — full
 * amounts stay on the tooltip; the axis gets the short form so long ticks don't
 * crowd the plot. Divides by the currency's real minor-unit factor. */
function compactMoney(minor: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / minorUnitFactor(currency, locale));
}

/** One-sentence `aria-label` for the figure — the number of months and the
 * latest net worth (the bands' signed sum), the summary the SVG can't convey. */
function describeComposition(
  points: CompositionPoint[],
  currency: string,
  locale?: string,
): string {
  if (points.length === 0) {
    return "Net worth composition: no data available.";
  }
  const latest = points[points.length - 1];
  return `Net worth composition across ${points.length} months; latest net worth ${formatMoney(
    netOf(latest),
    currency,
    locale,
  )}.`;
}

interface CompositionTooltipItem {
  dataKey?: string | number;
  value?: string | number;
  color?: string;
  payload?: CompositionPoint;
}

export interface CompositionTooltipProps {
  active?: boolean;
  payload?: CompositionTooltipItem[];
  /** The hovered point's `period_start` (Recharts passes the x value). */
  label?: string | number;
  currency: string;
  locale?: string;
}

/**
 * The composition tooltip — each band (label + swatch + signed amount) plus a
 * `Net` footer that sums the four (debts already negative). Mirrors the shared
 * `ChartTooltipContent`'s token styling (raised `--pc-surface-2`, hairline,
 * shadow) but adds the net-total row the generic tooltip has no slot for.
 * Exported so the summed total is unit-testable without hovering a chart.
 */
export function CompositionTooltipContent({
  active,
  payload,
  label,
  currency,
  locale,
}: CompositionTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const net = payload.reduce((sum, item) => sum + Number(item.value ?? 0), 0);
  return (
    <div className="min-w-[9rem] rounded-pc border border-hairline bg-surface-2 px-2.5 py-1.5 text-xs shadow-pc-2">
      {label !== undefined && label !== null && label !== "" ? (
        <div className="mb-1 font-medium text-ink">{monthLabel(String(label), locale)}</div>
      ) : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = String(item.dataKey ?? index);
          const name = compositionConfig[key as BandKey]?.label ?? key;
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-[2px] border border-hairline"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-ink-2">{name}</span>
              <span className="ml-auto font-mono tabular-figures text-ink">
                {formatMoney(Number(item.value ?? 0), currency, locale)}
              </span>
            </div>
          );
        })}
        <div className="mt-0.5 flex items-center gap-2 border-t border-hairline pt-1.5">
          <span className="text-ink-2">Net</span>
          <span className="ml-auto font-mono tabular-figures text-ink">
            {formatMoney(net, currency, locale)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Net-worth composition over time — a shadcn `ChartContainer` wrapping a
 * Recharts stacked `AreaChart` (x = month, y = amount). Three positive bands
 * (cash / assets / investments) share one stack and climb up from zero in the
 * vibrant `--chart-*` palette; the debts band, signed negative, rides its own
 * stack below zero in semantic coral, with a zero `ReferenceLine` marking the
 * divide. A legend names every
 * band and the tooltip breaks out each part plus the net total. Entrance
 * animation is off (reduced-motion-safe + deterministic tests); the labeled
 * `role="img"` figure carries the summary for assistive tech. A truly empty
 * series shows `empty` — never a chart of nothing (the dataviz constraint).
 */
export function NetWorthComposition({
  points,
  currency,
  empty,
  locale,
}: {
  points: CompositionPoint[];
  currency: string;
  empty: ReactNode;
  locale?: string;
}) {
  if (points.length === 0) {
    return <>{empty}</>;
  }

  const summary = describeComposition(points, currency, locale);

  return (
    <div className="flex flex-col gap-4">
      <ChartContainer
        config={compositionConfig}
        className="h-72 w-full"
        role="img"
        aria-label={summary}
      >
        <AreaChart
          data={points}
          stackOffset="none"
          margin={{ top: 8, right: 12, bottom: 0, left: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="period_start"
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
          <ReferenceLine y={0} />
          <ChartTooltip
            content={<CompositionTooltipContent currency={currency} locale={locale} />}
          />
          {BAND_KEYS.map((key) => (
            <Area
              key={key}
              dataKey={key}
              type="linear"
              stackId={stackIdOf(key)}
              stroke={`var(--color-${key})`}
              fill={`var(--color-${key})`}
              fillOpacity={0.85}
              strokeWidth={1}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ChartContainer>

      {/* A manual legend (spans, not a Recharts <Legend>) — identity never
          lives in color alone, and it sidesteps the internal props Recharts
          would spread onto a custom legend content node. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs">
        {BAND_KEYS.map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5 text-ink-2">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: compositionConfig[key].color }}
            />
            {compositionConfig[key].label}
          </span>
        ))}
      </div>
    </div>
  );
}
