import { useState } from "react";
import Card from "../../components/ui/Card";
import { focusRingClass } from "../../components/ui/a11y";
import { cn } from "../../lib/cn";
import { DateText, usePreferences } from "../../lib/preferences";
import { ChartEmpty, GraphCard } from "../analytics/GraphCard";
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
 * The forecast tab (`/forecast`, Track V) — "is my cash going to run out,
 * and when" for the workspace's **base currency**. A 6/12-month horizon
 * toggle drives `useProjection(months)`; the result renders a runway hero
 * (`RunwayHero`, above) and the headline two-line chart (`ProjectionChart`).
 *
 * Tasks 4 and 5 add the remaining sections directly below the chart: a KPI
 * tile row + per-month component breakdown (Task 4), and the debt-payoff
 * list via `useDebtPayoffs` (Task 5) — neither is implemented here; this
 * screen only builds the shell, nav, hero, and chart.
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

          {/* Task 4 slot: KPI tile row (runway/lowest-point/variable-spend
              figures) + a per-month `components` breakdown chart, both driven
              by this same `projection` — not implemented here. */}

          {/* Task 5 slot: the debt-payoff list, driven by `useDebtPayoffs()`
              from `./useForecast` — not implemented here. */}
        </>
      )}
    </div>
  );
}

export default ForecastScreen;
