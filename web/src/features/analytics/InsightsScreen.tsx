import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import { describeBreakdownBars, describeTrend } from "../../components/charts/chartMath";
import type { BreakdownItem, CashflowBar, ChartPoint } from "../../components/charts/chartMath";
import { apiFetch } from "../../lib/api";
import { formatMoney } from "../../lib/money";
import { usePreferences } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import type { ActivityEntry } from "../../lib/activity";
import AccountsSnapshot from "../dashboard/AccountsSnapshot";
import { buildBalanceSeries } from "../dashboard/balanceSeries";
import type { TransactionLite } from "../dashboard/balanceSeries";
import { selectPrimaryAccount } from "../dashboard/balances";
import type { AccountSummary, AssetSummary } from "../dashboard/balances";
import BalanceTiles from "../dashboard/BalanceTiles";
import CommittedMonthlyCard from "../dashboard/CommittedMonthlyCard";
import GoalsWidget from "../dashboard/GoalsWidget";
import NetWorthChangeCard from "../dashboard/NetWorthChangeCard";
import RecentActivity from "../dashboard/RecentActivity";
import SavingsRateCard from "../dashboard/SavingsRateCard";
import UpcomingWidget from "../dashboard/UpcomingWidget";
import { useLoans } from "../loans/useLoans";
import { usePortfolios } from "../portfolio/usePortfolios";
import { useProjectList } from "../projects/useProjects";
import type { ProjectOut } from "../projects/useProjects";
import { CashflowChart } from "./CashflowChart";
import { CategoryChart } from "./CategoryChart";
import type { DonutDatum, ForecastChartPoint } from "../../components/charts/chartMath";
import { ForecastArea } from "./ForecastArea";
import { ChartEmpty, ChartError, GraphCard } from "./GraphCard";
import { NetWorthComposition } from "./NetWorthComposition";
import { DEFAULT_PERIOD_SELECTION, computePeriodRange } from "./period";
import type { PeriodSelection } from "./period";
import { PeriodSelector } from "./PeriodSelector";
import {
  useCashflow,
  useForecast,
  useNetWorthComposition,
  useNetWorthSeries,
  useSpendingByCategory,
  useSpendingByContact,
} from "./useAnalytics";

interface KeysetResponse<T> {
  items: T[];
}

/** A net-worth series needs at least two points to draw a trend. */
const MIN_TREND_POINTS = 2;

/**
 * Insights reads a bounded snapshot of each listing — a summary view, not a
 * full paginated walk (that's each resource's own screen, built on
 * `DataList`). These limits comfortably cover a typical workspace;
 * `pecunia.pagination.MAX_LIMIT` is 200 server-side. Kept alongside the
 * relocated `BalanceTiles`/`AccountsSnapshot`/`RecentActivity` widgets below
 * (Task 6, Track U) — the same bounded reads the pre-Track-U Dashboard made.
 */
const ACCOUNTS_FETCH_LIMIT = 200;
const ASSETS_FETCH_LIMIT = 200;
const ACTIVITY_FETCH_LIMIT = 8;
/** How many of the primary account's most recent transactions to walk
 * backward through when reconstructing its balance series
 * (`balanceSeries.ts`) — a recent-trend window, not full history. */
const TRANSACTIONS_FETCH_LIMIT = 60;

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
 * complements, without duplicating, the lean daily `Dashboard` (Track U,
 * v1.6: `SafeToSpendCard`/`MonthResultCard`/`SpendingBreakdownCard`/
 * `UpcomingCard`/`AccountsCardsCard`). A shared period selector (last 3 / 6 /
 * 12 / 24 months, or All time) at the top drives every range-aware query on
 * the screen: a bounded month count computes the `{ from, to }` window, while
 * All time drops the client range and has the hooks send `?all=true` (the
 * server reads from the workspace's earliest activity). Either way the mode
 * rides in each query key, so switching refetches (see `useAnalytics`).
 *
 * Cards, all base-currency (never summed across currencies, §4), all
 * tokens-only with calm empty/loading/error states:
 *   - `BalanceTiles` — the net-worth hero + per-currency breakdown (Task 6:
 *     relocated from the pre-Track-U Dashboard, which no longer has a "right
 *     now" net-worth figure of its own).
 *   - The savings/committed/net-worth-change KPI trio (`SavingsRateCard`,
 *     `CommittedMonthlyCard`, `NetWorthChangeCard` — Task 6: relocated).
 *   - Net worth over time — `ForecastArea` over `/analytics/net-worth`'s last
 *     12 months, with a dashed projected tail from the same `forecastQuery`
 *     the Cash forecast card below already fetches (Task 6: relocated; no
 *     extra request for the tail).
 *   - Net worth composition — the existing stacked-area breakdown.
 *   - Income vs spend — `CashflowChart` over `/analytics/cashflow`'s last 12
 *     months (Task 6: relocated, extracted out of the old `Dashboard.tsx`
 *     into its own `CashflowChart.tsx` so this screen and any future caller
 *     share one implementation).
 *   - Spending by contact — a ranked horizontal breakdown (`BreakdownChart`).
 *   - Spending by category — the dashboard's shared `CategoryChart` donut over
 *     the window.
 *   - Project spend — derived from the projects list (`useProjectList`) with
 *     no new endpoint: each project's realized `actual_minor`, ranked. Project
 *     actuals are cumulative (there's no dated per-project figure), so this
 *     card is a current snapshot rather than being bound by the selector.
 *   - Cash forecast (Track O, v1.4) — the next 6 months of projected cash
 *     balance from `/analytics/forecast`, via the shared `ForecastArea`
 *     treatment (dashed line + uncertainty band + a zero reference line
 *     flagging a projected negative balance). Forward-looking, so unlike the
 *     other cards it ignores the period selector entirely — there's no
 *     historical cash-balance series to bound.
 *   - `AccountsSnapshot` + `UpcomingWidget` (Task 6: relocated) — a glanceable
 *     accounts list (with the primary account's sparkline) and the 30-day
 *     due/over-budget panel; both are richer, deeper-horizon siblings of the
 *     dashboard's own `AccountsCardsCard`/`UpcomingCard`, the same intentional
 *     duplication-by-depth this screen already applies to the category chart.
 *   - `GoalsWidget` + `RecentActivity` (Task 6: relocated).
 *
 * None of the relocated widgets above are range-aware — like Cash forecast,
 * they ignore the period selector and read their own server-bounded windows
 * (the same unranged `useAnalytics` calls the old Dashboard made).
 */
function InsightsScreen() {
  const preferences = usePreferences();
  const baseCurrency = preferences.base_currency;
  const locale = preferences.locale;

  // "Today" is fixed for the life of the screen so the window is stable across
  // re-renders; only changing the selection recomputes the range. The all-time
  // mode computes no range — `allTime` makes the hooks send `?all=true`.
  const [today] = useState(() => new Date());
  const [selection, setSelection] = useState<PeriodSelection>(DEFAULT_PERIOD_SELECTION);
  const allTime = selection.kind === "all";
  const range = useMemo(
    () => (selection.kind === "months" ? computePeriodRange(selection.months, today) : undefined),
    [selection, today],
  );

  const compositionQuery = useNetWorthComposition({ range, allTime });
  const contactQuery = useSpendingByContact({ range, allTime });
  const categoryQuery = useSpendingByCategory({ range, allTime });
  const projectsQuery = useProjectList();
  // Forward-looking, so it ignores the period selector entirely (see the
  // component docstring).
  const forecastQuery = useForecast();
  // Server-bounded to the last 12 months, independent of the period selector
  // above — same unranged reads the old Dashboard made (Task 6: relocated).
  const netWorthQuery = useNetWorthSeries();
  const cashflowQuery = useCashflow();

  // The relocated `BalanceTiles`/`AccountsSnapshot`/`RecentActivity` widgets'
  // own bounded reads — see the `"dashboard"`-suffixed key rationale on
  // `Dashboard.tsx`'s own `accountsQuery` (same collision this screen must
  // dodge against `AccountsScreen`'s `useInfiniteQuery`).
  const accountsQuery = useQuery({
    queryKey: [...qk.accounts, "dashboard"],
    queryFn: () =>
      apiFetch<KeysetResponse<AccountSummary>>(`/accounts?limit=${ACCOUNTS_FETCH_LIMIT}`),
  });
  const assetsQuery = useQuery({
    queryKey: [...qk.assets, "dashboard"],
    queryFn: () => apiFetch<KeysetResponse<AssetSummary>>(`/assets?limit=${ASSETS_FETCH_LIMIT}`),
  });
  const portfoliosQuery = usePortfolios();
  const loansQuery = useLoans();
  const activityQuery = useQuery({
    queryKey: [...qk.activity, "dashboard"],
    queryFn: () =>
      apiFetch<KeysetResponse<ActivityEntry>>(`/activity?limit=${ACTIVITY_FETCH_LIMIT}`),
  });

  const accounts = accountsQuery.data?.items ?? [];
  const activeAccounts = accounts.filter((account) => account.archived_at === null);
  const primary = selectPrimaryAccount(activeAccounts, baseCurrency);

  const transactionsQuery = useQuery({
    queryKey: [...qk.transactions(primary?.id), "dashboard"],
    queryFn: () => {
      if (!primary) {
        // Never actually invoked while disabled — typed defensively rather
        // than asserting non-null.
        return Promise.resolve<KeysetResponse<TransactionLite>>({ items: [] });
      }
      return apiFetch<KeysetResponse<TransactionLite>>(
        `/transactions?account_id=${primary.id}&limit=${TRANSACTIONS_FETCH_LIMIT}`,
      );
    },
    enabled: primary !== null,
  });

  const assets = assetsQuery.data?.items ?? [];
  const portfolios = portfoliosQuery.data?.items ?? [];
  const loans = loansQuery.data?.items ?? [];
  const activity = activityQuery.data?.items ?? [];
  const primarySeries =
    primary && transactionsQuery.data
      ? buildBalanceSeries(primary.balance_minor, transactionsQuery.data.items)
      : [];

  const netWorthPoints: ChartPoint[] = (netWorthQuery.data ?? []).map((point) => ({
    date: point.date,
    valueMinor: point.net_worth_minor,
  }));
  // Reuses the same `forecastQuery` the Cash forecast card below already
  // fetches — its `.net_worth` field is the net-worth chart's dashed tail.
  const netWorthProjected: ForecastChartPoint[] = (forecastQuery.data?.net_worth ?? []).map(
    (point) => ({
      date: point.date,
      valueMinor: point.value_minor,
      lowerMinor: point.lower_minor,
      upperMinor: point.upper_minor,
    }),
  );
  const cashflowBars: CashflowBar[] = (cashflowQuery.data ?? []).map((point) => ({
    periodStart: point.period_start,
    incomeMinor: point.income_minor,
    spendMinor: point.spend_minor,
  }));

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

  const cashProjected: ForecastChartPoint[] = (forecastQuery.data?.cash ?? []).map((point) => ({
    date: point.date,
    valueMinor: point.value_minor,
    lowerMinor: point.lower_minor,
    upperMinor: point.upper_minor,
  }));

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
        <PeriodSelector value={selection} onChange={setSelection} />
      </div>

      <BalanceTiles
        accounts={activeAccounts}
        assets={assets}
        portfolios={portfolios}
        loans={loans}
        baseCurrency={baseCurrency}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SavingsRateCard />
        <CommittedMonthlyCard />
        <NetWorthChangeCard />
      </div>

      <GraphCard title="Net worth over time">
        {netWorthQuery.isError ? (
          <ChartError />
        ) : netWorthPoints.length < MIN_TREND_POINTS ? (
          <ChartEmpty>
            {netWorthQuery.isLoading
              ? "Loading…"
              : "No net-worth history yet — it builds up as your balances and assets change."}
          </ChartEmpty>
        ) : (
          <ForecastArea
            data={{ history: netWorthPoints, projected: netWorthProjected }}
            metric="net_worth"
            currency={baseCurrency}
            locale={locale}
            ariaLabel={describeTrend("Net worth", netWorthPoints, baseCurrency, locale)}
            empty={
              <ChartEmpty>No net-worth history yet — it builds up as your balances and assets change.</ChartEmpty>
            }
          />
        )}
      </GraphCard>

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

      <GraphCard title="Income vs spend">
        {cashflowQuery.isError ? (
          <ChartError />
        ) : cashflowBars.length === 0 ? (
          <ChartEmpty>
            {cashflowQuery.isLoading ? "Loading…" : "No income or spending recorded yet."}
          </ChartEmpty>
        ) : (
          <CashflowChart bars={cashflowBars} currency={baseCurrency} locale={locale} />
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

      <GraphCard title="Cash forecast">
        {forecastQuery.isError ? (
          <ChartError />
        ) : (
          <ForecastArea
            data={{ history: [], projected: cashProjected }}
            metric="cash"
            currency={baseCurrency}
            locale={locale}
            empty={
              <ChartEmpty>
                {forecastQuery.isLoading
                  ? "Loading…"
                  : "No committed transactions to project yet — add planned income, subscriptions, or loan payments."}
              </ChartEmpty>
            }
          />
        )}
      </GraphCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AccountsSnapshot
          accounts={activeAccounts}
          primaryAccountId={primary?.id}
          primarySeries={primarySeries}
        />
        <UpcomingWidget />
      </div>

      <GoalsWidget />

      <RecentActivity entries={activity} />
    </div>
  );
}

export default InsightsScreen;
