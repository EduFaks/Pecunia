import { DateText, MoneyText } from "../../lib/preferences";
import { debtPayoffFraction } from "./debtPayoff";
import { useDebtPayoffs } from "./useForecast";
import type { DebtPayoff } from "./useForecast";

/**
 * The fixed horizon `/analytics/debt-payoffs` projects across server-side
 * (`_PAYOFF_HORIZON_MONTHS`, `api/src/pecunia/services/projection.py`),
 * mirrored here ONLY for copy ("não quita em 24 meses") — never for any
 * stepping math. The frontend has neither the loan's `next_due` nor its
 * cadence-aware stepping to reproduce that calculation honestly, so this is
 * purely a label, not a recomputation.
 */
const PAYOFF_HORIZON_MONTHS = 24;

/**
 * One debt's progress bar — same visual contract as `LoanPayoffBar`'s own
 * track/fill (`bg-surface-2` track, `bg-accent` fill): a payoff bar is
 * progress toward something the user is acting on, the CONVENTIONS §9.1
 * carve-out that lets it use the accent outside an interactive control.
 * Rendered at a genuine 0% (empty track, no fabricated fill) when the debt
 * isn't projected to clear within the horizon at all — honestly "no
 * progress visible", not a guess.
 */
function PayoffBar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(fraction * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Progresso de quitação de ${label}`}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-150 ease-pc"
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}

function DebtPayoffRow({ debt }: { debt: DebtPayoff }) {
  const known = debt.payoff_date !== null && debt.payments_left !== null;
  const fraction = known ? debtPayoffFraction(debt.payments_left as number) : 0;

  return (
    <li className="flex flex-col gap-2 py-3 min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 min-w-0">
        <span className="min-w-0 truncate text-sm text-ink">{debt.name}</span>
        <MoneyText minor={debt.remaining_minor} currency={debt.currency} className="shrink-0 text-sm" />
      </div>

      {known ? (
        <>
          <p className="text-xs text-ink-faint">
            quitado em <DateText iso={debt.payoff_date as string} />
          </p>
          <p className="text-xs text-ink-faint">
            {debt.payments_left}× <MoneyText minor={debt.planned_payment_minor} currency={debt.currency} />
          </p>
        </>
      ) : (
        <p className="text-xs text-ink-faint">não quita em {PAYOFF_HORIZON_MONTHS} meses</p>
      )}

      <PayoffBar fraction={fraction} label={debt.name} />
    </li>
  );
}

/**
 * The forecast tab's debt-payoff list (Task 5) — one row per borrowed loan
 * with a projected payoff ETA (`useDebtPayoffs`, `./useForecast`): the
 * remaining balance, when it clears ("quitado em <date>" + the "N× payment"
 * caption) or the honest "não quita em 24 meses" when it doesn't resolve
 * within the server's horizon, and a small payoff-progress bar
 * (`debtPayoffFraction`, `./debtPayoff`).
 *
 * Self-contained (calls its own hook, same shape `UpcomingWidget` uses)
 * rather than fed via props — `ForecastScreen` just drops `<DebtPayoffList
 * />` into its Task-5 slot. A genuinely empty list (no debts with a
 * programmed payment at all) hides the section's card/heading entirely,
 * leaving only a one-line muted note — there is nothing to show a "Quitação
 * de dívidas" heading over.
 */
function DebtPayoffList() {
  const { data, isLoading, isError } = useDebtPayoffs();
  const debts = data ?? [];

  if (!isLoading && !isError && debts.length === 0) {
    return <p className="text-sm text-ink-faint">sem dívidas com pagamento programado</p>;
  }

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6 min-w-0">
      <h2 className="font-display text-lg text-ink">Quitação de dívidas</h2>

      {isError ? (
        <p className="mt-4 text-sm text-ink-faint">
          Não foi possível carregar suas dívidas. Tente atualizar.
        </p>
      ) : isLoading ? (
        <p className="mt-4 text-sm text-ink-2">Carregando…</p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-hairline min-w-0">
          {debts.map((debt) => (
            <DebtPayoffRow key={debt.loan_id} debt={debt} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default DebtPayoffList;
