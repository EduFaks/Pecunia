import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { describeCashflow, describeTrend } from "../../components/charts/chartMath";
import type { CashflowBar, ChartPoint, DonutDatum, ForecastChartPoint } from "../../components/charts/chartMath";
import EmptyState from "../../components/data/EmptyState";
import Button from "../../components/ui/Button";
import Callout from "../../components/ui/Callout";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../components/ui/chart";
import type { ChartConfig } from "../../components/ui/chart";
import Spinner from "../../components/ui/Spinner";
import { apiFetch } from "../../lib/api";
import type { ActivityEntry } from "../../lib/activity";
import { formatMoney, minorUnitFactor } from "../../lib/money";
import { usePreferences } from "../../lib/preferences";
import { qk } from "../../lib/queries";
import { CategoryChart } from "../analytics/CategoryChart";
import { ForecastArea } from "../analytics/ForecastArea";
import { ChartEmpty, ChartError, GraphCard } from "../analytics/GraphCard";
import {
  useCashflow,
  useForecast,
  useNetWorthSeries,
  useSpendingByCategory,
} from "../analytics/useAnalytics";
import { useLoans } from "../loans/useLoans";
import { usePortfolios } from "../portfolio/usePortfolios";
import AccountsSnapshot from "./AccountsSnapshot";
import BalanceTiles from "./BalanceTiles";
import { buildBalanceSeries } from "./balanceSeries";
import type { TransactionLite } from "./balanceSeries";
import { selectPrimaryAccount } from "./balances";
import type { AccountSummary, AssetSummary } from "./balances";
import CommittedMonthlyCard from "./CommittedMonthlyCard";
import NetWorthChangeCard from "./NetWorthChangeCard";
import RecentActivity from "./RecentActivity";
import SavingsRateCard from "./SavingsRateCard";
import UpcomingWidget from "./UpcomingWidget";

interface KeysetResponse<T> {
  items: T[];
}

/** A net-worth series needs at least two points to draw a trend. */
const MIN_TREND_POINTS = 2;

/** Month-and-year axis/tooltip label from an ISO month start, read in UTC so
 * it doesn't drift with the viewer's timezone (same rationale as `formatDate`). */
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
 * deterministic tests).
 */
function CashflowChart({
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

/**
 * The Dashboard reads a bounded snapshot of each listing — a summary
 * screen, not a full paginated walk (that's each resource's own `/accounts`
 * /`/assets` screen, built on `DataList`). These limits comfortably cover a
 * typical workspace; `pecunia.pagination.MAX_LIMIT` is 200 server-side.
 */
const ACCOUNTS_FETCH_LIMIT = 200;
const ASSETS_FETCH_LIMIT = 200;
const ACTIVITY_FETCH_LIMIT = 8;
/** How many of the primary account's most recent transactions to walk
 * backward through when reconstructing its balance series
 * (`balanceSeries.ts`) — a recent-trend window, not full history. */
const TRANSACTIONS_FETCH_LIMIT = 60;

/**
 * The Dashboard — Pecunia's showpiece screen, mounted at `/`. Assembles
 * `/accounts` + `/assets` into a per-currency net-worth summary
 * (`BalanceTiles`), charts the snapshot-backed **net worth over time** as the
 * single headline figure (`ForecastArea` over `/analytics/net-worth`, with a
 * dashed projected tail appended from `/analytics/forecast` — Track O, v1.4),
 * breaks cashflow and spending into their own graphs, and previews accounts +
 * recent activity. The primary account's own recent-balance trend
 * (reconstructed from `/transactions`) is demoted to the inline sparkline
 * inside `AccountsSnapshot` — not a second full-width line chart. A fresh
 * instance with no accounts gets a welcoming empty state instead of an empty
 * grid of zeroes — the app is fully usable with nothing (the firm contract).
 */
function Dashboard() {
  const navigate = useNavigate();
  const preferences = usePreferences();

  // Every key below is suffixed `"dashboard"` — same move `AssetDetail`'s
  // bounded chart fetch already makes on `qk.assetValuations(id)` (see that
  // file's docstring) — to keep this screen's bounded, flat `useQuery` reads
  // out of the exact cache slot each resource's own paginated screen reads
  // via `useInfiniteQuery` (`AccountDetail`/`TransactionsScreen`'s
  // `qk.transactions(id)`, `AssetsScreen`'s `qk.assets`, `ActivityScreen`'s
  // `qk.activity`). Without the suffix, whichever screen mounts second finds
  // this screen's plain `{items, next_cursor}` payload already cached under
  // its literal key and hands it to `useInfiniteQuery` as if it were an
  // already-paginated `{pages, pageParams}` result — `getNextPageParam`
  // then reads `.pages` off a value that doesn't have it and throws,
  // crashing the whole tree (no error boundary catches it). The suffix is
  // still a nested key, so `qk.accounts`/`qk.assets`/`qk.transactions()`
  // invalidation (a mutation, `financeQueryKeys` on demo removal) still
  // covers it via TanStack's prefix match.
  const accountsQuery = useQuery({
    queryKey: [...qk.accounts, "dashboard"],
    queryFn: () =>
      apiFetch<KeysetResponse<AccountSummary>>(`/accounts?limit=${ACCOUNTS_FETCH_LIMIT}`),
  });
  const assetsQuery = useQuery({
    queryKey: [...qk.assets, "dashboard"],
    queryFn: () => apiFetch<KeysetResponse<AssetSummary>>(`/assets?limit=${ASSETS_FETCH_LIMIT}`),
  });
  // Portfolios read through the shared `usePortfolios` hook (flat, plain
  // `useQuery` — no `useInfiniteQuery`/`DataList` reads the portfolios key
  // anywhere, so unlike accounts/assets above there's no shape collision to
  // dodge with a `"dashboard"` suffix). Its `value_minor`/`currency` per
  // portfolio feed the net-worth tile below.
  const portfoliosQuery = usePortfolios();
  // Loans read through the shared `useLoans` hook (flat, plain `useQuery` —
  // same rationale as portfolios above: no `DataList` reads the loans key, so
  // no `"dashboard"` suffix is needed to dodge a shape collision). Each loan's
  // `direction`/`remaining_minor`/`currency` feeds the net-worth tile below as
  // a signed term (borrowed subtracts, lent adds).
  const loansQuery = useLoans();
  const activityQuery = useQuery({
    queryKey: [...qk.activity, "dashboard"],
    queryFn: () =>
      apiFetch<KeysetResponse<ActivityEntry>>(`/activity?limit=${ACTIVITY_FETCH_LIMIT}`),
  });

  const accounts = accountsQuery.data?.items ?? [];
  const activeAccounts = accounts.filter((account) => account.archived_at === null);
  const primary = selectPrimaryAccount(activeAccounts, preferences.base_currency);

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

  // The three analytics graphs — each reads its endpoint and picks the
  // workspace's base currency out of the per-currency response (see
  // `useAnalytics`). Bounded server-side to the last 12 months.
  const netWorthQuery = useNetWorthSeries();
  const cashflowQuery = useCashflow();
  const categoryQuery = useSpendingByCategory();
  // The forecast engine (Track O, v1.4) — the net-worth chart's dashed
  // projected tail, appended after the real history above.
  const forecastQuery = useForecast();

  const netWorthPoints: ChartPoint[] = (netWorthQuery.data ?? []).map((point) => ({
    date: point.date,
    valueMinor: point.net_worth_minor,
  }));
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
  const categoryData: DonutDatum[] = (categoryQuery.data ?? []).map((row) => ({
    key: row.category_id ?? "uncategorized",
    label: row.name,
    valueMinor: row.spend_minor,
    color: row.color,
  }));
  // Only categories with positive spend get a slice (a zero-spend bucket has
  // no wedge) — mirrors the old donut's positive-only geometry.
  const positiveCategories = categoryData.filter((datum) => datum.valueMinor > 0);

  if (accountsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner label="Loading your dashboard" />
      </div>
    );
  }

  if (accountsQuery.isError) {
    return <Callout variant="negative">Couldn't load your accounts. Try refreshing the page.</Callout>;
  }

  if (activeAccounts.length === 0) {
    return (
      <EmptyState
        title="Welcome to Pecunia"
        body="You don't have any accounts yet. Add your first one to start tracking balances, transactions, and net worth."
        action={<Button onClick={() => navigate("/accounts")}>Add your first account</Button>}
      />
    );
  }

  const assets = assetsQuery.data?.items ?? [];
  const portfolios = portfoliosQuery.data?.items ?? [];
  const loans = loansQuery.data?.items ?? [];
  const activity = activityQuery.data?.items ?? [];
  const baseCurrency = preferences.base_currency;
  const series =
    primary && transactionsQuery.data
      ? buildBalanceSeries(primary.balance_minor, transactionsQuery.data.items)
      : [];

  return (
    <div className="flex flex-col gap-8">
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
            locale={preferences.locale}
            ariaLabel={describeTrend("Net worth", netWorthPoints, baseCurrency, preferences.locale)}
            empty={
              <ChartEmpty>No net-worth history yet — it builds up as your balances and assets change.</ChartEmpty>
            }
          />
        )}
      </GraphCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GraphCard title="Income vs spend">
          {cashflowQuery.isError ? (
            <ChartError />
          ) : cashflowBars.length === 0 ? (
            <ChartEmpty>
              {cashflowQuery.isLoading ? "Loading…" : "No income or spending recorded yet."}
            </ChartEmpty>
          ) : (
            <CashflowChart bars={cashflowBars} currency={baseCurrency} locale={preferences.locale} />
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
            <CategoryChart
              data={positiveCategories}
              currency={baseCurrency}
              locale={preferences.locale}
            />
          )}
        </GraphCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AccountsSnapshot
          accounts={activeAccounts}
          primaryAccountId={primary?.id}
          primarySeries={series}
        />
        <UpcomingWidget />
      </div>

      <RecentActivity entries={activity} />
    </div>
  );
}

export default Dashboard;
