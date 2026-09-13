import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import { describeBreakdownBars } from "../../components/charts/chartMath";
import type { BreakdownItem } from "../../components/charts/chartMath";
import { formatMoney } from "../../lib/money";
import { usePreferences } from "../../lib/preferences";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import { useProjectList } from "../projects/useProjects";
import type { ProjectOut } from "../projects/useProjects";
import { CategoryChart } from "./CategoryChart";
import type { DonutDatum } from "../../components/charts/chartMath";
import { ChartEmpty, ChartError, GraphCard } from "./GraphCard";
import { NetWorthComposition } from "./NetWorthComposition";
import { DEFAULT_PERIOD_MONTHS, computePeriodRange } from "./period";
import { PeriodSelector } from "./PeriodSelector";
import { useNetWorthComposition, useSpendingByCategory, useSpendingByContact } from "./useAnalytics";

/** One row of a ranked breakdown. `note` is an optional muted secondary
 * caption (e.g. a project's "of $500.00 planned"). */
interface BreakdownRow extends BreakdownItem {
  note?: string;
}

/** The vibrant categorical fills a breakdown cycles through, row by row — the
 * `--chart-1…8` tokens (CONVENTIONS §9's sanctioned vibrant exception) keep
 * adjacent bars distinct and legible on the near-black ground. A ranking is a
 * magnitude comparison, never value movement, so emerald/coral stay out of it
 * (§9.1). */
const BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

/** How tall each ranked row's bar sits, in px — the chart's height scales with
 * the row count so bars keep a constant, legible thickness rather than
 * stretching to fill a fixed box. */
const ROW_HEIGHT = 30;

/**
 * A ranked horizontal breakdown — spending by contact, project spend — as a
 * Recharts `BarChart` (`layout="vertical"`) via `ChartContainer`. Rows run
 * descending by value with the vibrant `--chart-*` palette cycled per row; the
 * bars are the at-a-glance magnitude read (`role="img"` + a
 * `describeBreakdownBars` summary), and a companion legend beneath carries each
 * row's exact label, optional note, and amount (identity + figures never live
 * in color/geometry alone — the same donut-plus-legend idiom `CategoryChart`
 * uses). Non-positive rows are dropped; an all-empty breakdown shows `empty`
 * (never a bar of nothing, the dataviz constraint). No entrance animation, so
 * `prefers-reduced-motion` has nothing to suppress and tests are deterministic.
 */
function BreakdownChart({
  rows,
  currency,
  label,
  empty,
  locale,
}: {
  rows: BreakdownRow[];
  currency: string;
  /** Names the ranking for the summary + accessible names ("Spending by
   * contact", "Project spend"). */
  label: string;
  empty: ReactNode;
  locale?: string;
}) {
  const ranked = rows
    .filter((row) => row.valueMinor > 0)
    .sort((a, b) => b.valueMinor - a.valueMinor);

  if (ranked.length === 0) {
    return <>{empty}</>;
  }

  const data = ranked.map((row, index) => ({
    ...row,
    fill: BAR_COLORS[index % BAR_COLORS.length],
  }));
  const summary = describeBreakdownBars(label, rows, currency, locale);
  const config: ChartConfig = { valueMinor: { label } };

  return (
    <div className="flex flex-col gap-4">
      <ChartContainer
        config={config}
        className="w-full"
        style={{ height: ranked.length * ROW_HEIGHT + 8, aspectRatio: "auto" }}
        role="img"
        aria-label={summary}
      >
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 4, bottom: 0, left: 4 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" hide />
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideLabel
                valueFormatter={(value) => formatMoney(Number(value), currency, locale)}
              />
            }
          />
          <Bar dataKey="valueMinor" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((row) => (
              <Cell key={row.key} fill={row.fill} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>

      <ul aria-label={summary} className="flex flex-col gap-2 text-sm">
        {data.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3">
            <span className="inline-flex min-w-0 items-baseline gap-2 text-ink-2">
              <span
                aria-hidden="true"
                className="relative top-[1px] h-2.5 w-2.5 shrink-0 self-center rounded-[2px]"
                style={{ backgroundColor: row.fill }}
              />
              <span className="truncate">{row.label}</span>
              {row.note ? (
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{row.note}</span>
              ) : null}
            </span>
            <span className="shrink-0 font-mono tabular-figures text-ink">
              {formatMoney(row.valueMinor, currency, locale)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A project's secondary caption on its spend bar: how the realized funding
 * (`actual_minor`) sits against the plan — a `target_amount_minor` if one is
 * set, else the Σ-of-estimates `planned_minor`. Omitted when there's no bound
 * to compare against. */
function projectNote(project: ProjectOut, currency: string, locale?: string): string | undefined {
  if (project.target_amount_minor && project.target_amount_minor > 0) {
    return `of ${formatMoney(project.target_amount_minor, currency, locale)} target`;
  }
  if (project.planned_minor > 0) {
    return `of ${formatMoney(project.planned_minor, currency, locale)} planned`;
  }
  return undefined;
}

/**
 * The Insights screen (`/insights`) — the deeper analytical view that
 * complements, without duplicating, the dashboard's three headline graphs.
 * A shared period selector (last 3 / 6 / 12 months) at the top computes the
 * `{ from, to }` window every range-aware query on the screen reads, so
 * switching it refetches spending-by-contact and spending-by-category against
 * the new window (the range rides in each query key, see `useAnalytics`).
 *
 * Three cards, all base-currency (never summed across currencies, §4), all
 * tokens-only with calm empty/loading/error states matching the dashboard:
 *   - Spending by contact — a ranked horizontal breakdown (`BreakdownChart`).
 *   - Spending by category — the dashboard's shared `CategoryChart` donut over
 *     the window.
 *   - Project spend — derived from the projects list (`useProjectList`) with
 *     no new endpoint: each project's realized `actual_minor`, ranked. Project
 *     actuals are cumulative (there's no dated per-project figure), so this
 *     card is a current snapshot rather than being bound by the selector.
 */
function InsightsScreen() {
  const preferences = usePreferences();
  const baseCurrency = preferences.base_currency;
  const locale = preferences.locale;

  // "Today" is fixed for the life of the screen so the window is stable across
  // re-renders; only changing the month count recomputes the range.
  const [today] = useState(() => new Date());
  const [months, setMonths] = useState(DEFAULT_PERIOD_MONTHS);
  const range = useMemo(() => computePeriodRange(months, today), [months, today]);

  const compositionQuery = useNetWorthComposition({ range });
  const contactQuery = useSpendingByContact({ range });
  const categoryQuery = useSpendingByCategory({ range });
  const projectsQuery = useProjectList();

  const contactRows: BreakdownRow[] = (contactQuery.data ?? []).map((row) => ({
    key: row.contact_id ?? "no-contact",
    label: row.name,
    valueMinor: row.spend_minor,
  }));

  const categoryData: DonutDatum[] = (categoryQuery.data ?? []).map((row) => ({
    key: row.category_id ?? "uncategorized",
    label: row.name,
    valueMinor: row.spend_minor,
    color: row.color,
  }));
  // Only categories with positive spend get a wedge (mirrors the dashboard's
  // positive-only donut geometry).
  const positiveCategories = categoryData.filter((datum) => datum.valueMinor > 0);

  const projectRows: BreakdownRow[] = (projectsQuery.data?.items ?? [])
    .filter((project) => project.currency === baseCurrency)
    .map((project) => ({
      key: project.id,
      label: project.name,
      valueMinor: project.actual_minor,
      note: projectNote(project, baseCurrency, locale),
    }));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl text-ink">Insights</h1>
          <p className="mt-1 text-sm text-ink-2">
            A deeper look at where your money goes, over your chosen period.
          </p>
        </div>
        <PeriodSelector months={months} onChange={setMonths} />
      </div>

      <GraphCard title="Net worth composition">
        {compositionQuery.isError ? (
          <ChartError />
        ) : (
          <NetWorthComposition
            points={compositionQuery.data ?? []}
            currency={baseCurrency}
            locale={locale}
            empty={
              <ChartEmpty>
                {compositionQuery.isLoading
                  ? "Loading…"
                  : "No net-worth composition yet — add accounts, assets, holdings, or loans to see the breakdown."}
              </ChartEmpty>
            }
          />
        )}
      </GraphCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GraphCard title="Spending by contact">
          {contactQuery.isError ? (
            <ChartError />
          ) : (
            <BreakdownChart
              rows={contactRows}
              currency={baseCurrency}
              label="Spending by contact"
              locale={locale}
              empty={
                <ChartEmpty>
                  {contactQuery.isLoading ? "Loading…" : "No contact spending in this period yet."}
                </ChartEmpty>
              }
            />
          )}
        </GraphCard>

        <GraphCard title="Spending by category">
          {categoryQuery.isError ? (
            <ChartError />
          ) : positiveCategories.length === 0 ? (
            <ChartEmpty>
              {categoryQuery.isLoading ? "Loading…" : "No spending to break down yet."}
            </ChartEmpty>
          ) : (
            <CategoryChart data={positiveCategories} currency={baseCurrency} locale={locale} />
          )}
        </GraphCard>
      </div>

      <GraphCard title="Project spend">
        {projectsQuery.isError ? (
          <ChartError />
        ) : (
          <BreakdownChart
            rows={projectRows}
            currency={baseCurrency}
            label="Project spend"
            locale={locale}
            empty={
              <ChartEmpty>
                {projectsQuery.isLoading ? "Loading…" : "No project spending recorded yet."}
              </ChartEmpty>
            }
          />
        )}
      </GraphCard>
    </div>
  );
}

export default InsightsScreen;
