import { MoneyText, usePreferences } from "../../lib/preferences";
import { useSummary } from "../analytics/useAnalytics";
import { useSafeToSpend } from "./useDashboard";

/**
 * The dashboard's month-result card (Track U, v1.6): "what came in, what
 * went out" this month (`useSummary`'s `savings.income_minor`/`spend_minor`,
 * the same MTD figures `SavingsRateCard` reads) plus a projected end-of-month
 * surplus/deficit.
 *
 * The projection deliberately reuses `useSafeToSpend`'s `safe_minor`
 * (`expected_income_minor − committed_remaining_minor − spent_mtd_minor`)
 * rather than recomputing the same arithmetic a second way — one source of
 * truth for "how much free money is left/short by month end," shared with
 * the hero `SafeToSpendCard`. `safe_minor` (not `displayed_safe_minor`) on
 * purpose: `displayed_safe_minor` can be clamped by an optional monthly
 * budget (`limited_by: "budget"`), which would otherwise make a true deficit
 * read as "$0.00" here instead of the negative figure it actually is.
 * Green (`text-positive`, backed by `--pc-positive`) at zero or above, red
 * (`text-negative`/`--pc-negative`) below — matching the brief's `>= 0`
 * threshold, which is why this doesn't just reuse `MoneyText`'s
 * `colorBySign` (that prop treats exactly zero as neutral ink).
 *
 * Each "entrou"/"saiu" row also shows a muted "(previsto …)" figure from
 * `useSafeToSpend`'s `projected_income_minor`/`projected_expense_minor` —
 * the same end-of-month projection already computed for the safe-to-spend
 * metric, reused here rather than recomputed. Always rendered, even when it
 * equals the actual (nothing else scheduled this month is still a
 * projection, not an absence of one).
 */
function MonthResultCard() {
  const { base_currency } = usePreferences();
  const summaryQuery = useSummary();
  const safeToSpendQuery = useSafeToSpend();

  const savings = summaryQuery.data?.savings;
  const entry = safeToSpendQuery.data?.[base_currency];

  const isError = summaryQuery.isError || safeToSpendQuery.isError;
  const isLoading = summaryQuery.isLoading || safeToSpendQuery.isLoading;
  const isEmpty = !savings || !entry;

  const projectionColorClass =
    entry && entry.safe_minor >= 0 ? "text-positive" : "text-negative";

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6 min-w-0">
      <h2 className="font-display text-lg text-ink">Resultado do mês</h2>

      {isError ? (
        <p className="mt-5 text-sm text-ink-faint">
          Não foi possível carregar o resultado do mês. Tente atualizar.
        </p>
      ) : isLoading ? (
        <p className="mt-5 text-sm text-ink-2">Carregando…</p>
      ) : isEmpty || !savings || !entry ? (
        <p className="mt-5 text-sm text-ink-2">Sem dados para este mês ainda.</p>
      ) : (
        <div className="mt-5 flex flex-col gap-2 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 min-w-0">
            <span className="text-sm text-ink-2">Entrou</span>
            <span className="flex flex-wrap items-baseline justify-end gap-x-1.5 min-w-0">
              <MoneyText minor={savings.income_minor} currency={base_currency} className="text-sm" />
              <span className="text-xs text-ink-faint">
                (previsto{" "}
                <MoneyText
                  minor={entry.projected_income_minor}
                  currency={base_currency}
                  className="text-xs text-ink-faint"
                />
                )
              </span>
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 min-w-0">
            <span className="text-sm text-ink-2">Saiu</span>
            <span className="flex flex-wrap items-baseline justify-end gap-x-1.5 min-w-0">
              <MoneyText minor={savings.spend_minor} currency={base_currency} className="text-sm" />
              <span className="text-xs text-ink-faint">
                (previsto{" "}
                <MoneyText
                  minor={entry.projected_expense_minor}
                  currency={base_currency}
                  className="text-xs text-ink-faint"
                />
                )
              </span>
            </span>
          </div>

          <div className="mt-3 border-t border-hairline pt-3 min-w-0">
            <p className="text-xs text-ink-faint">Projeção fim do mês</p>
            <MoneyText
              minor={entry.safe_minor}
              currency={base_currency}
              variant="hero"
              className={`mt-1 block text-3xl ${projectionColorClass}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default MonthResultCard;
