import { TrendingDown, TrendingUp } from "lucide-react";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { useSummary } from "../analytics/useAnalytics";

/** A basis-points rate as a one-decimal percentage string ("60.0%"). */
function formatRateBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/**
 * The dashboard's savings-rate tile (Track R, v1.4): this month's saved
 * amount (income minus spend, a genuine delta so it's `colorBySign`) plus
 * its rate, with a trend arrow against the prior month's rate — emerald up,
 * coral down, no arrow when unchanged. Base-currency; a calm empty state
 * when neither income nor spending has landed yet this month (or the
 * currency has no figures at all).
 */
function SavingsRateCard() {
  const { base_currency } = usePreferences();
  const summaryQuery = useSummary();
  const savings = summaryQuery.data?.savings;
  const isEmpty = !savings || (savings.income_minor === 0 && savings.spend_minor === 0);

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <h2 className="font-display text-lg text-ink">Savings rate</h2>

      {summaryQuery.isError ? (
        <p className="mt-4 text-sm text-ink-faint">Couldn't load your savings rate. Try refreshing.</p>
      ) : summaryQuery.isLoading ? (
        <p className="mt-4 text-sm text-ink-2">Loading…</p>
      ) : isEmpty || !savings ? (
        <p className="mt-4 text-sm text-ink-2">No income or spending recorded this month yet.</p>
      ) : (
        <div className="mt-4">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <MoneyText
              minor={savings.saved_minor}
              currency={base_currency}
              colorBySign
              variant="hero"
              className="text-3xl"
            />
            <span className="font-mono text-sm text-ink-2">{formatRateBps(savings.rate_bps)}</span>
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-faint">
            {savings.rate_bps > savings.prev_rate_bps ? (
              <TrendingUp aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-positive" />
            ) : savings.rate_bps < savings.prev_rate_bps ? (
              <TrendingDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-negative" />
            ) : null}
            <span>vs {formatRateBps(savings.prev_rate_bps)} last month</span>
          </p>
        </div>
      )}
    </div>
  );
}

export default SavingsRateCard;
