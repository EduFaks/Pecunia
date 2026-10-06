# Pecunia v1.7 — Forecast ("Previsão") Tab (Design)

**Status:** approved 2026-10-06. A new forward-looking screen. Call it **Track V**.

## Goal

Give the app a dedicated multi-month forward view that answers the questions the current-month dashboard can't: *will my cash stay positive?*, *how does this month's deficit (e.g. a big card bill) drag the next months?*, *when does my next income bring me back to black?*, and *when are my debts paid off?* — every number explainable by its components, nothing duplicated from the dashboard/Insights.

## Global constraints

Follows `docs/CONVENTIONS.md`:
- Money = integer minor units, **never summed across currencies** (per-currency maps); services flush / routers commit; services **clock-free** (`today: date` passed in).
- Frontend: Tailwind `--pc-*` tokens only (no raw hex); `--pc-positive`/`--pc-negative` for value movement only; Recharts via the existing wrappers; `MoneyText`/`DateText`; `qk` factory; co-located Vitest; mobile-first (`min-w-0`, `flex-wrap`, safe-area).
- Base-currency (BRL) primary view; other currencies selectable/secondary, never summed in.
- Conventional commits, NO trailers. TDD. `pytest` + `npm run build && lint && test` green, 0 new warnings.
- **Explainable, not a black box** — reuse the existing forecast philosophy: committed center + average-variable band, every projected figure decomposable into its component deltas.

## What already exists (do NOT rebuild)

- `ForecastService.forecast(workspace_id, *, today, months=6)` → per-currency `{cash, net_worth}` month-end points `{date, value_minor, lower_minor, upper_minor, projected}`, carry-forward running balance, committed-only center, linear-widening variable band. Inputs: scheduled tx, subscriptions, loan payments. **Does NOT include credit-card bills.** (`api/src/pecunia/services/forecast.py`)
- Net-worth-over-time (history + dashed projected tail) and a cash-forecast chart already live on **Insights** (`ForecastArea`). The net-worth trajectory stays there — the Forecast tab does NOT duplicate it.
- Current-month forward figures (safe-to-spend, projected end-of-month, 14/30-day upcoming, next card-bill date) live on the dashboard. The Forecast tab owns the **>1-month** horizon only.
- Goal ETA reuses forecast (`GoalService.eta`). Loans have NO payoff timeline yet.

## Locked decisions (from brainstorming)

1. Dedicated **"Previsão" tab** (6th bottom-tab).
2. Content: (a) projected-cash hero chart, (b) runway + lowest-point, (c) recovery-from-red, (d) debt-payoff ETA. Net-worth trajectory stays on Insights (not duplicated).
3. Cash projection must **include known credit-card bills** as one-time outflows at their rolled due date (the current forecast omits them).
4. Show **two lines**: optimistic (committed only) and realistic (committed + average variable); headline numbers derive from the **realistic** line.
5. Every projected figure carries a **component breakdown** (income / subscriptions / loans / card bills / average-variable, with the lookback count stated).
6. **Pay-in-full** card assumption → no revolving-card amortization; debt-payoff lists **loans** only (revolving model deferred).

---

## Track V — the work

### V-1. ProjectionService (backend)

New `api/src/pecunia/services/projection.py` (`ProjectionService`), clock-free, per currency, building on the existing forecast building blocks (reuse `expand_occurrences`, `AnalyticsService.cashflow`/`committed_monthly`, `ForecastService._cash_start` logic, `AnalyticsService` band-average). `project(workspace_id, *, today, months=6) -> dict[str, ProjectionOut]`.

For each currency, walk month-ends from the month after `today` through `months`:
- Start = current cash (per currency, `sum(AccountService.balance)` — same as forecast's cash start).
- **Component deltas per month** (each kept separately, not just the net):
  - `income_minor` = Σ scheduled income occurrences that month.
  - `subscriptions_minor` = Σ subscription renewals that month (outflow).
  - `loans_minor` = Σ loan planned payments that month (outflow).
  - `card_bills_minor` = Σ each linked credit card's known upcoming bill (`max(0, abs(provider_balance_minor) − card_spend_mtd)` for the FIRST cycle, i.e. the bill already accrued) placed as a **one-time outflow** in the month of its `next_due_on_or_after(bill_due_date, today)`. Future cycles' card spend is NOT separately modeled (it falls under average-variable). Each card bill counted once.
  - `variable_minor` = the month's share of average monthly non-recurring spend (`AnalyticsService` band average, the same `_recent_avg_monthly_expense` basis), a per-month outflow — only applied to the REALISTIC line.
- `optimistic_balance_minor` = running start + Σ(income − subscriptions − loans − card_bills) [no variable].
- `realistic_balance_minor` = optimistic − cumulative variable (variable applied each month).
- Each `ProjectionPoint`: `{ date, optimistic_minor, realistic_minor, components: {income_minor, subscriptions_minor, loans_minor, card_bills_minor, variable_minor}, card_bill_labels: [{label, amount_minor}] }` (labels so the UI can annotate "fatura BTG").

**Derived headline fields** (`ProjectionOut`), from the **realistic** series:
- `runway_months`: index (1-based) of the first month whose `realistic_minor < 0`, or `null` if it stays ≥ 0 through the horizon; plus `runway_until: date|null`.
- `lowest_point`: `{ value_minor, date }` = min realistic balance over the horizon (include the current-month-end as month 0 start so a this-month dip shows).
- `recovery`: `{ date, value_minor }|null` = first month realistic goes back ≥ 0 after being < 0 (the "next income pays it back" moment); `null` if never negative or never recovers in horizon.
- `variable_lookback_months`: the N behind the average-variable figure (for the breakdown caption).
- `currency`.

**Debt payoff** (separate, deterministic, horizon up to 24 months): `debt_payoffs(workspace_id, *, today) -> list[DebtPayoutOut]` — per loan with `planned_payment_minor` + `payment_frequency` + `next_due` set: `remaining = LoanService.remaining_minor(loan)`; step the payment by frequency from `next_due`, subtracting `planned_payment_minor` each step until ≤ 0; `payoff_date` = that step's date, `payments_left` = count. No interest (model has none). `{ loan_id, name, remaining_minor, planned_payment_minor, payment_frequency, payoff_date: date|null, payments_left: int|null, currency }`; `null` payoff when the loan never amortizes within 24 months (e.g. payment ≤ 0).

**Endpoints:** `GET /api/v1/analytics/projection?months=6` (1–24, default 6) → `dict[str, ProjectionOut]`; `GET /api/v1/analytics/debt-payoffs` → `list[DebtPayoutOut]`. Both `require_workspace`/`require_initialized`, router passes `today=date.today()`.

**Tests:** component decomposition sums to the net delta; card bill lands once in its due month and drags the realistic+optimistic lines; a this-month-deficit scenario carries forward (next month starts lower); runway null when always positive vs the right month when it dips; lowest-point value+date; recovery detection (dips then next income ≥0) and null when no recovery; realistic ≤ optimistic each month; per-currency isolation; debt payoff date/payments-left for a simple loan, null for a non-amortizing one; clock-free.

### V-2. Forecast screen (frontend)

New `web/src/features/forecast/` — `ForecastScreen.tsx` + hooks `useForecastProjection()` / `useDebtPayoffs()` (`qk.analytics.projection(months)`, `qk.analytics.debtPayoffs()`), route `/forecast`, base currency. Top→bottom:

1. **Runway hero** — "Seu caixa fica no azul pelos próximos N meses" (positive tone) or "Seu caixa zera em ~N meses (mês/ano)" (negative tone), from `runway_months`/`runway_until`.
2. **Projected-cash chart** (`ProjectionChart`, reuse/extend `ForecastArea`): realistic line (solid), optimistic line (dashed, lighter), zero `ReferenceLine`, markers on the lowest point and recovery point, card-bill events annotated on the x-axis. 6-month default + a 6/12 horizon toggle (`PeriodSelector`-style). Tapping a month opens its **breakdown** (see 4).
3. **Lowest point + Recovery** — two compact stat tiles: "Menor saldo −R$X · 10/nov (após fatura BTG)" and "De volta ao azul · 15/nov, +R$Y". Recovery tile hidden when never negative.
4. **"O que compõe" breakdown** — an expandable per-month component list (from `ProjectionPoint.components` + `card_bill_labels`): signed, colored rows (+renda / −assinaturas / −empréstimos / −fatura <label> / −variável médio) with the "variável médio" row captioned "média de {variable_lookback_months} meses". Either inline under the chart for the selected month, or a small stacked list — every headline number traces here.
5. **Debt payoff** — one row per loan: name, remaining (`MoneyText`), "quitado em mar/2027" (or "não quita em 24 meses"), `payments_left` × planned payment, a small progress bar (reuse `payoff.ts`'s paid/principal bar).

Empty/degraded states per section (no loans → hide debt section with a one-liner; no forward data → calm empty state).

### V-3. Navigation (frontend)

Add "Previsão" to the bottom `TabBar` (`web/src/components/layout/TabBar.tsx`) as a 6th tab (lucide `LineChart`/`TrendingUp`), route `/forecast` in `App.tsx`, and a sidebar/drawer entry. If six icon+label tabs prove too tight below the smallest breakpoint, move the least-used primary tab (candidate: Transações, also reachable from the dashboard) into the drawer — decided during implementation against the real layout; start with six.

## Testing strategy

TDD per unit. Backend: pytest + testcontainers, no network, fixtures for scheduled/subs/loans/linked-cards. Frontend: Vitest + Testing Library, `apiFetch` mocked, Recharts stubbed; assert the two lines, markers, breakdown rows, runway/recovery copy, debt-payoff rows, and the TabBar 6th entry active state. Everything green, 0 new warnings.

## Out of scope / deferred

Revolving-card amortization (interest-bearing minimum-payment model); net-worth multi-month milestone ETA (net-worth trajectory stays on Insights); scenario/what-if sliders; per-category forward projection; modeling future (not-yet-accrued) credit-card cycles beyond the average-variable band; horizons past 24 months.
