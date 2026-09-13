import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/cn";

/**
 * A trimmed, token-driven adaptation of the shadcn `chart` primitive for
 * Pecunia's Tailwind v4 + `--pc-*` design system. It is the one sanctioned
 * home for vibrant color in an otherwise monochrome UI (CONVENTIONS §9): the
 * `--chart-1…8` tokens (and each category's stored color) drive the marks.
 *
 * NO raw hex literals live here — every color arrives through the caller's
 * `ChartConfig` (a token reference like `var(--chart-3)` / `var(--pc-positive)`,
 * or a value already carried by the data) and is surfaced to Recharts as a
 * `--color-<key>` CSS variable, so marks paint with `fill="var(--color-<key>)"`.
 */

/** How a chart series presents: its human label and the color that paints it. */
export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    /** A CSS color string — always a token reference or data-carried value. */
    color?: string;
  }
>;

interface ChartContextValue {
  config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextValue | null>(null);

/** Config from the nearest `ChartContainer`, or `{}` when rendered standalone. */
function useChartConfig(): ChartConfig {
  return React.useContext(ChartContext)?.config ?? {};
}

export interface ChartContainerProps extends React.ComponentProps<"div"> {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}

/**
 * Wraps a single Recharts chart in a `ResponsiveContainer`, publishes each
 * configured series color as a `--color-<key>` CSS variable on the wrapper
 * (custom properties inherit down into the chart's SVG), and provides the
 * config to `ChartTooltipContent` / `ChartLegendContent`.
 */
const ChartContainer = React.forwardRef<HTMLDivElement, ChartContainerProps>(
  function ChartContainer({ config, className, children, style, ...rest }, ref) {
    const colorVars = React.useMemo(() => {
      const vars: Record<string, string> = {};
      for (const [key, item] of Object.entries(config)) {
        if (item.color) {
          vars[`--color-${key}`] = item.color;
        }
      }
      return vars;
    }, [config]);

    return (
      <div
        ref={ref}
        data-chart=""
        className={cn(
          "flex aspect-video w-full justify-center text-xs text-ink-2",
          "[&_.recharts-cartesian-axis-tick_text]:fill-ink-faint",
          "[&_.recharts-cartesian-grid_line]:stroke-hairline",
          "[&_.recharts-radial-bar-background-sector]:fill-surface-2",
          "[&_.recharts-reference-line_line]:stroke-hairline-strong",
          "[&_.recharts-surface]:overflow-visible",
          className,
        )}
        style={{ ...colorVars, ...style } as React.CSSProperties}
        {...rest}
      >
        <ChartContext.Provider value={{ config }}>
          <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
        </ChartContext.Provider>
      </div>
    );
  },
);

/** The Recharts `Tooltip`; pair its `content` with `ChartTooltipContent`. */
const ChartTooltip = RechartsPrimitive.Tooltip;

interface TooltipPayloadItem {
  name?: string | number;
  value?: string | number;
  dataKey?: string | number;
  color?: string;
  payload?: Record<string, unknown> & { fill?: string };
}

export interface ChartTooltipContentProps extends React.ComponentProps<"div"> {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: React.ReactNode;
  /** Key into `ChartConfig` to resolve each row's label (defaults per item). */
  nameKey?: string;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  labelFormatter?: (label: React.ReactNode, payload: TooltipPayloadItem[]) => React.ReactNode;
  valueFormatter?: (value: string | number, item: TooltipPayloadItem) => React.ReactNode;
}

/**
 * A token-styled tooltip body (raised `--pc-surface-2`, hairline, shadow) for
 * Recharts `Tooltip`'s `content`. Resolves each row's label from the chart
 * config when available, and paints a small swatch in the series color.
 */
const ChartTooltipContent = React.forwardRef<HTMLDivElement, ChartTooltipContentProps>(
  function ChartTooltipContent(
    {
      active,
      payload,
      label,
      nameKey,
      hideLabel = false,
      hideIndicator = false,
      labelFormatter,
      valueFormatter,
      className,
      ...rest
    },
    ref,
  ) {
    const config = useChartConfig();

    if (!active || !payload || payload.length === 0) {
      return null;
    }

    const resolvedLabel = hideLabel
      ? null
      : labelFormatter
        ? labelFormatter(label, payload)
        : label;

    return (
      <div
        ref={ref}
        className={cn(
          "min-w-[8rem] rounded-pc border border-hairline bg-surface-2 px-2.5 py-1.5 text-xs shadow-pc-2",
          className,
        )}
        {...rest}
      >
        {resolvedLabel !== null && resolvedLabel !== undefined && resolvedLabel !== "" ? (
          <div className="mb-1 font-medium text-ink">{resolvedLabel}</div>
        ) : null}
        <div className="grid gap-1.5">
          {payload.map((item, index) => {
            const key = nameKey ?? String(item.dataKey ?? item.name ?? index);
            const itemConfig = config[key] ?? config[String(item.dataKey ?? "")];
            const indicatorColor = item.color ?? item.payload?.fill;
            const name = itemConfig?.label ?? item.name;
            return (
              <div key={key} className="flex items-center gap-2">
                {!hideIndicator ? (
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px] border border-hairline"
                    style={{ backgroundColor: indicatorColor }}
                  />
                ) : null}
                {name !== undefined && name !== null ? (
                  <span className="text-ink-2">{name}</span>
                ) : null}
                {item.value !== undefined && item.value !== null ? (
                  <span className="ml-auto font-mono tabular-figures text-ink">
                    {valueFormatter ? valueFormatter(item.value, item) : item.value}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);

/** The Recharts `Legend`; pair its `content` with `ChartLegendContent`. */
const ChartLegend = RechartsPrimitive.Legend;

interface LegendPayloadItem {
  value?: string | number;
  dataKey?: string | number;
  color?: string;
}

export interface ChartLegendContentProps extends React.ComponentProps<"div"> {
  payload?: LegendPayloadItem[];
  hideIcon?: boolean;
  nameKey?: string;
  verticalAlign?: "top" | "middle" | "bottom";
}

/** A token-styled legend for Recharts `Legend`'s `content`. */
const ChartLegendContent = React.forwardRef<HTMLDivElement, ChartLegendContentProps>(
  function ChartLegendContent(
    { payload, hideIcon = false, nameKey, verticalAlign = "bottom", className, ...rest },
    ref,
  ) {
    const config = useChartConfig();

    if (!payload || payload.length === 0) {
      return null;
    }

    return (
      <div
        ref={ref}
        className={cn(
          "flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5",
          verticalAlign === "top" ? "pb-3" : "pt-3",
          className,
        )}
        {...rest}
      >
        {payload.map((item, index) => {
          const key = nameKey ?? String(item.dataKey ?? item.value ?? index);
          const itemConfig = config[key] ?? config[String(item.value ?? "")];
          return (
            <div key={key} className="flex items-center gap-1.5 text-xs text-ink-2">
              {!hideIcon ? (
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-[2px] border border-hairline"
                  style={{ backgroundColor: item.color }}
                />
              ) : null}
              {itemConfig?.label ?? item.value}
            </div>
          );
        })}
      </div>
    );
  },
);

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
};
