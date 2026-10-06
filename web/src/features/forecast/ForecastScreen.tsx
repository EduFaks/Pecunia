import { useState } from "react";
import type { ReactNode } from "react";
import Card from "../../components/ui/Card";
import { focusRingClass } from "../../components/ui/a11y";
import { cn } from "../../lib/cn";
import { DateText, MoneyText, usePreferences } from "../../lib/preferences";
import { ChartEmpty, GraphCard } from "../analytics/GraphCard";
import { biggestCardBillLabel, findPointByDate, SIGN_POSITIVE } from "./forecastCopy";
import MonthBreakdown from "./MonthBreakdown";
import { ProjectionChart } from "./ProjectionChart";
import { useProjection } from "./useForecast";
import type { Projection } from "./useForecast";

/** The horizon toggle's two options — the only two the brief/endpoint's
 * `months` contract (`ge=1,le=24`) are asked to offer here. */
const HORIZONS = [6, 12] as const;
type Horizon = (typeof HORIZONS)[number];

/** "1 mês" vs "N meses" — the same singular/plural idiom
 * `SafeToSpendCard`'s `days_remaining === 1 ? "dia" : "dias"` already uses. */
function monthWord(n: number): string {
  return n === 1 ? "mês" : "meses";
}

/**
 * The horizon toggle: a segmented `role="group"` of 6/12-month options, the
 * app's established selector pattern (`PeriodSelector`'s identical
 * treatment for the Insights reporting window). The active horizon carries
 * the neutral accent-soft tint (a selection, never value movement, so no
 * emerald/coral); `aria-pressed` marks the choice for assistive tech.
 */
function HorizonToggle({
  value,
  onChange,
}: {
  value: Horizon;
  onChange: (horizon: Horizon) => void;
}) {
  const optionClass = (pressed: boolean) =>
    cn(
      "rounded-pc px-3 py-1.5 text-sm transition-colors duration-150 ease-pc",
      pressed ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
      focusRingClass,
    );

  return (
    <div
      role="group"
      aria-label="Horizonte da previsão"
      className="inline-flex w-fit rounded-pc border border-hairline p-0.5"
    >
      {HORIZONS.map((horizon) => {
        const pressed = value === horizon;
        return (
          <button
            key={horizon}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(horizon)}
            className={optionClass(pressed)}
          >
            {horizon} meses
          </button>
        );
      })}
    </div>
  );
}

/**
 * The runway hero: positive copy when the realistic line never dips below
 * zero within the projected horizon (`runway_months === null`), negative
 * copy with the rolled `runway_until` date otherwise. `runway_months`/
 * `lowest_point`/`recovery` are all read off the realistic line server-side
 * (`ProjectionService._derive`), seeded with today's actual balance ahead of
 * the projected points — so an already-overdrawn balance today reports
 * `runway_months = 0`, never a false "no risk" `null`. The negative case's
 * `text-negative` mirrors `SafeToSpendCard`'s "você passou do limite" flag —
 * a genuine alert state, not a plain amount, so it earns the coral token
 * (CONVENTIONS §9.1 reserves emerald/coral for real movement/urgency, not
 * decoration).
 */
function RunwayHero({ projection }: { projection: Projection }) {
  const isPositive = projection.runway_months === null;
  const monthsCount = projection.points.length;

  return (
    <Card>
      <p className="text-xs text-ink-faint">previsão de caixa</p>
      {isPositive ? (
        <p className="mt-2 font-display text-xl text-ink sm:text-2xl">
          Seu caixa fica no azul pelos próximos {monthsCount} {monthWord(monthsCount)}
        </p>
      ) : (
        <p className="mt-2 font-display text-xl text-negative sm:text-2xl">
          Seu caixa zera em ~{projection.runway_months} {monthWord(projection.runway_months as number)}{" "}
          (<DateText iso={projection.runway_until as string} />)
        </p>
      )}
    </Card>
  );
}

/**
 * The "menor saldo" stat tile (Task 4): `lowest_point.value_minor`
 * (`flagNegative` — a plain balance that may dip below zero, not a delta,
 * so never green-by-default) + its `DateText`, plus a short "após fatura
 * <label>" note when that same month also carries a credit-card bill —
 * naming the BIGGEST one when a month folds in more than one card
 * (`biggestCardBillLabel`). `lowest_point.date` doesn't always match one of
 * `projection.points` (it can be TODAY's seeded actual balance when today is
 * already the series' minimum, same caveat `ProjectionChart`'s reference dot
 * documents), so the note is simply omitted when no matching point — or no
 * bill at all — is found.
 */
function LowestPointTile({ projection, currency }: { projection: Projection; currency: string }) {
  const { lowest_point } = projection;
  const point = findPointByDate(projection.points, lowest_point.date);
  const cardBill = point ? biggestCardBillLabel(point.card_bill_labels) : undefined;

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6 min-w-0">
      <p className="text-xs text-ink-faint">menor saldo</p>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
        <MoneyText
          minor={lowest_point.value_minor}
          currency={currency}
          variant="hero"
          flagNegative
          className="text-2xl"
        />
        <DateText iso={lowest_point.date} className="text-sm text-ink-faint" />
      </p>
      {cardBill ? (
        <p className="mt-1 text-xs text-ink-faint">após fatura {cardBill.label}</p>
      ) : null}
    </div>
  );
}

/**
 * The "recuperação" stat tile (Task 4) — three mutually exclusive states,
 * all read off `Projection`:
 *
 * - `recovery !== null`: "De volta ao azul" + the rolled `DateText` + the
 *   signed, emerald `recovery.value_minor` — a genuine state transition
 *   (climbing back out of the red), so it earns the explicit "+" glyph and
 *   `text-positive` the same way a real gain/delta does elsewhere.
 * - `recovery === null` and the realistic line never dips below zero at all
 *   (`runway_months === null` AND `lowest_point.value_minor >= 0`, the same
 *   pair `RunwayHero` reads for its own "no risk" branch): a reassuring
 *   one-liner, deliberately PLAIN ink — mirrors `RunwayHero`'s own positive
 *   case, which stays uncolored too (CONVENTIONS §9.1 reserves emerald for
 *   real movement, and "nothing happened" isn't movement).
 * - `recovery === null` otherwise: the dip is real but never climbs back
 *   within the projected horizon — a muted, deliberately uncelebratory line.
 */
function RecoveryTile({ projection, currency }: { projection: Projection; currency: string }) {
  const { recovery, runway_months, lowest_point } = projection;

  let body: ReactNode;
  if (recovery) {
    body = (
      <>
        <p className="mt-2 font-display text-base text-ink">De volta ao azul</p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
          <DateText iso={recovery.date} className="text-sm text-ink-2" />
          <span className="text-positive">
            {SIGN_POSITIVE}
            <MoneyText minor={recovery.value_minor} currency={currency} className="text-sm" />
          </span>
        </p>
      </>
    );
  } else if (runway_months === null && lowest_point.value_minor >= 0) {
    body = <p className="mt-2 text-sm text-ink-2">Caixa positivo o período todo</p>;
  } else {
    body = <p className="mt-2 text-sm text-ink-faint">sem recuperação prevista no período</p>;
  }

  return (
    <div className="rounded-pc-lg border border-hairline bg-surface-1 p-6 min-w-0">
      <p className="text-xs text-ink-faint">recuperação</p>
      {body}
    </div>
  );
}

/**
 * The forecast tab (`/forecast`, Track V) — "is my cash going to run out,
 * and when" for the workspace's **base currency**. A 6/12-month horizon
 * toggle drives `useProjection(months)`; the result renders a runway hero
 * (`RunwayHero`, above) and the headline two-line chart (`ProjectionChart`).
 *
 * Below the chart: the lowest-point/recovery stat tiles and the per-month
 * `MonthBreakdown` ("o que compõe") — Task 4. Task 5 still owes the
 * debt-payoff list via `useDebtPayoffs` (`./useForecast`) — not implemented
 * here.
 */
function ForecastScreen() {
  const { base_currency, locale } = usePreferences();
  const [horizon, setHorizon] = useState<Horizon>(6);
  const projectionQuery = useProjection(horizon);
  const projection = projectionQuery.data;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl text-ink">Previsão</h1>
          <p className="mt-1 text-sm text-ink-2">
            Projeção do seu caixa com base no que já está programado.
          </p>
        </div>
        <HorizonToggle value={horizon} onChange={setHorizon} />
      </div>

      {projectionQuery.isError ? (
        <Card>
          <p className="text-sm text-ink-faint">
            Não foi possível carregar sua previsão. Tente atualizar.
          </p>
        </Card>
      ) : projectionQuery.isLoading ? (
        <Card>
          <p className="text-sm text-ink-2">Carregando…</p>
        </Card>
      ) : !projection || projection.points.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-2">
            Sem dados suficientes para projetar seu caixa ainda.
          </p>
        </Card>
      ) : (
        <>
          <RunwayHero projection={projection} />

          <GraphCard title="Projeção de caixa">
            {/* `isError`/empty are both already handled by the outer
                branch above — reaching here always means a loaded,
                non-empty `projection`. */}
            <ProjectionChart
              points={projection.points}
              lowestPoint={projection.lowest_point}
              recovery={projection.recovery}
              currency={base_currency}
              locale={locale}
              empty={<ChartEmpty>Sem dados suficientes para projetar seu caixa ainda.</ChartEmpty>}
            />
          </GraphCard>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <LowestPointTile projection={projection} currency={base_currency} />
            <RecoveryTile projection={projection} currency={base_currency} />
          </div>

          {/* `key={horizon}` remounts the breakdown (resetting its own
              selected-month state) whenever the horizon toggle swaps in a
              brand-new `points` array, rather than leaving a now-stale
              selected date selected against the new series. */}
          <MonthBreakdown
            key={horizon}
            points={projection.points}
            lowestPointDate={projection.lowest_point.date}
            variableLookbackMonths={projection.variable_lookback_months}
            currency={base_currency}
            locale={locale}
          />

          {/* Task 5 slot: the debt-payoff list, driven by `useDebtPayoffs()`
              from `./useForecast` — not implemented here. */}
        </>
      )}
    </div>
  );
}

export default ForecastScreen;
