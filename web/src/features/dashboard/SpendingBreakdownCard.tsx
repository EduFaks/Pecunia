import type { DonutDatum } from "../../components/charts/chartMath";
import { MoneyText, usePreferences } from "../../lib/preferences";
import { CategoryChart } from "../analytics/CategoryChart";
import { useCashflow, useSpendingByCategory } from "../analytics/useAnalytics";

/**
 * This month's spend vs. last month's, as a signed percent — `null` (never
 * `NaN`/`Infinity`) when last month had no spend to compare against, so a
 * brand-new workspace (or a currency's first month of activity) can't divide
 * by zero. Kept pure and exported so the guard is unit-testable without
 * rendering the card — same rationale as `SafeToSpendCard.safeToSpendPercent`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function cashflowDeltaPct(currentMinor: number, previousMinor: number): number | null {
  if (previousMinor === 0) {
    return null;
  }
  return ((currentMinor - previousMinor) / previousMinor) * 100;
}

interface DeltaDisplay {
  text: string;
  colorClass: string;
}

/** Turns a `cashflowDeltaPct` result (plus this month's own spend) into the
 * card's "↑/↓ X% vs mês passado" copy: an up arrow in red when spend grew
 * (more spending is the unwelcome direction), a down arrow in green when it
 * shrank, calm ink when flat, and "novo"/"—" for the zero-previous-month
 * guard — "novo" when there's something to show this month with nothing to
 * compare it to, "—" when both months are empty. */
function formatDelta(deltaPct: number | null, currentMinor: number): DeltaDisplay {
  if (deltaPct === null) {
    return currentMinor > 0
      ? { text: "novo", colorClass: "text-ink-faint" }
      : { text: "—", colorClass: "text-ink-faint" };
  }
  if (deltaPct === 0) {
    return { text: "sem variação", colorClass: "text-ink-faint" };
  }
  const arrow = deltaPct > 0 ? "↑" : "↓";
  const colorClass = deltaPct > 0 ? "text-negative" : "text-positive";
  return { text: `${arrow} ${Math.abs(deltaPct).toFixed(1)}%`, colorClass };
}

/**
 * The dashboard's spending-breakdown card (Track U, v1.6): the base
 * currency's `CategoryChart` donut (`useSpendingByCategory`, the same shared
 * component/data Insights and the legacy dashboard graph use), this month's
 * total (Σ positive category spend), and a "vs mês passado" comparison
 * against the prior month's total spend (`useCashflow`, oldest-first —
 * the last two points are this month and last month).
 */
function SpendingBreakdownCard() {
  const { base_currency, locale } = usePreferences();
  const categoryQuery = useSpendingByCategory();
  const cashflowQuery = useCashflow();

  const categoryData: DonutDatum[] = (categoryQuery.data ?? []).map((row) => ({
    key: row.category_id ?? "uncategorized",
    label: row.name,
    valueMinor: row.spend_minor,
    color: row.color,
  }));
  const positiveCategories = categoryData.filter((datum) => datum.valueMinor > 0);
  const totalMinor = positiveCategories.reduce((sum, datum) => sum + datum.valueMinor, 0);

  const cashflow = cashflowQuery.data ?? [];
  const current = cashflow.length >= 1 ? cashflow[cashflow.length - 1] : undefined;
  const previous = cashflow.length >= 2 ? cashflow[cashflow.length - 2] : undefined;
  const deltaPct = current ? cashflowDeltaPct(current.spend_minor, previous?.spend_minor ?? 0) : null;
  const delta = current ? formatDelta(deltaPct, current.spend_minor) : null;

  const isError = categoryQuery.isError || cashflowQuery.isError;
  const isLoading = categoryQuery.isLoading || cashflowQuery.isLoading;
  const isEmpty = positiveCategories.length === 0;

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6 min-w-0">
      <h2 className="font-display text-lg text-ink">Gastei em quê</h2>

      {isError ? (
        <p className="mt-5 text-sm text-ink-faint">
          Não foi possível carregar seus gastos. Tente atualizar.
        </p>
      ) : isLoading ? (
        <p className="mt-5 text-sm text-ink-2">Carregando…</p>
      ) : isEmpty ? (
        <p className="mt-5 text-sm text-ink-2">Nenhum gasto neste mês ainda.</p>
      ) : (
        <div className="mt-5 min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 min-w-0">
            <MoneyText minor={totalMinor} currency={base_currency} variant="hero" className="text-3xl" />
            {delta ? (
              <span className="flex items-center gap-1 text-xs">
                <span className={delta.colorClass}>{delta.text}</span>
                <span className="text-ink-faint">vs mês passado</span>
              </span>
            ) : null}
          </div>
          <div className="mt-4">
            <CategoryChart data={positiveCategories} currency={base_currency} locale={locale} />
          </div>
        </div>
      )}
    </div>
  );
}

export default SpendingBreakdownCard;
