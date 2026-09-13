import { MoneyText, usePreferences } from "../../lib/preferences";
import { useSummary } from "../analytics/useAnalytics";

/**
 * The dashboard's committed-monthly-cost tile (Track R, v1.4): "what leaves
 * before you spend anything" — Σ active subscriptions + loan planned
 * payments + active recurring planned expenses, each already normalized to a
 * monthly figure server-side. The breakdown lists only the parts that
 * actually contribute (a zero-cost part is simply absent, not a "$0.00"
 * row). Base-currency; a calm empty state when nothing is committed yet.
 */
function CommittedMonthlyCard() {
  const { base_currency } = usePreferences();
  const summaryQuery = useSummary();
  const committed = summaryQuery.data?.committed_monthly;
  const isEmpty = !committed || committed.total_minor === 0;

  const rows = committed
    ? [
        { label: "Subscriptions", minor: committed.subscriptions_minor },
        { label: "Loan payments", minor: committed.loans_minor },
        { label: "Planned", minor: committed.planned_minor },
      ].filter((row) => row.minor > 0)
    : [];

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6">
      <h2 className="font-display text-lg text-ink">Committed monthly cost</h2>

      {summaryQuery.isError ? (
        <p className="mt-4 text-sm text-ink-faint">Couldn't load your committed costs. Try refreshing.</p>
      ) : summaryQuery.isLoading ? (
        <p className="mt-4 text-sm text-ink-2">Loading…</p>
      ) : isEmpty || !committed ? (
        <p className="mt-4 text-sm text-ink-2">
          Nothing committed yet — subscriptions, loan payments, and planned expenses show up here.
        </p>
      ) : (
        <div className="mt-4">
          <MoneyText
            minor={committed.total_minor}
            currency={base_currency}
            variant="hero"
            className="text-3xl"
          />
          <p className="mt-1 text-xs text-ink-faint">What leaves before you spend anything</p>
          <ul className="mt-4 flex flex-col divide-y divide-hairline text-sm">
            {rows.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-3 py-2">
                <span className="text-ink-2">{row.label}</span>
                <MoneyText minor={row.minor} currency={base_currency} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default CommittedMonthlyCard;
