import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { useSummary } from "../analytics/useAnalytics";

/** A basis-points delta as a signed one-decimal percentage ("+50.0%",
 * "-28.6%") — `toFixed` already carries a negative number's minus sign, so
 * only the positive case needs an explicit "+". */
function formatPctBps(bps: number): string {
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(1)}%`;
}

/**
 * The dashboard's net-worth-change tile (Track R, v1.4): `net_worth_as_of
 * (today)` vs. the start of the month, as a delta (`colorBySign` — a genuine
 * gain/loss figure) + percentage, with a directional arrow, plus the top
 * movers (the net-worth components — cash/assets/investments/debts — that
 * actually shifted, largest first). Base-currency; a calm empty state when
 * the currency has no figures at all.
 */
function NetWorthChangeCard() {
  const { base_currency } = usePreferences();
  const summaryQuery = useSummary();
  const change = summaryQuery.data?.net_worth_change;

  let TrendIcon: LucideIcon = Minus;
  let trendColor = "text-ink-faint";
  if (change && change.delta_minor > 0) {
    TrendIcon = ArrowUpRight;
    trendColor = "text-positive";
  } else if (change && change.delta_minor < 0) {
    TrendIcon = ArrowDownRight;
    trendColor = "text-negative";
  }

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <h2 className="font-display text-lg text-ink">Net worth change</h2>

      {summaryQuery.isError ? (
        <p className="mt-4 text-sm text-ink-faint">
          Couldn't load your net-worth change. Try refreshing.
        </p>
      ) : summaryQuery.isLoading ? (
        <p className="mt-4 text-sm text-ink-2">Loading…</p>
      ) : !change ? (
        <p className="mt-4 text-sm text-ink-2">
          No net-worth history yet — it builds up as your balances and assets change.
        </p>
      ) : (
        <div className="mt-4">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <TrendIcon aria-hidden="true" className={`h-4 w-4 shrink-0 self-center ${trendColor}`} />
            <MoneyText
              minor={change.delta_minor}
              currency={base_currency}
              colorBySign
              variant="hero"
              className="text-3xl"
            />
            <span className="font-mono text-sm text-ink-2">{formatPctBps(change.pct_bps)}</span>
          </p>
          <p className="mt-1 text-xs text-ink-faint">since the start of the month</p>
          {change.movers.length > 0 ? (
            <ul className="mt-4 flex flex-col divide-y divide-hairline text-sm">
              {change.movers.map((mover) => (
                <li key={mover.label} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-ink-2">{mover.label}</span>
                  <MoneyText minor={mover.delta_minor} currency={base_currency} colorBySign />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default NetWorthChangeCard;
