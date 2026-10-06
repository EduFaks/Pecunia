# Track V (v1.7) — Forecast ("Previsão") Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated forward-looking "Previsão" tab: projected cash over 6–12 months (carrying this month's deficit/surplus forward, including known credit-card bills), with runway, lowest-point, recovery-from-red, a per-month component breakdown, and loan payoff ETAs — nothing duplicated from the dashboard/Insights.

**Architecture:** A new `ProjectionService` builds on the existing forecast building blocks (`expand_occurrences`, `AnalyticsService.cashflow`/`committed_monthly`, `AccountService.balance`) to produce a per-currency monthly cash walk with TWO lines (optimistic = committed only; realistic = committed + average variable), folds each linked credit card's known bill as a one-time outflow at its rolled due date, keeps per-month component deltas, and derives runway/lowest-point/recovery; a separate deterministic `debt_payoffs`. Two new `/analytics` endpoints feed a new `web/src/features/forecast/` screen reachable from a 6th bottom-tab.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest+testcontainers; Vite/React/TS, TanStack Query, Recharts, Vitest, Tailwind v4.

## Global Constraints

- `docs/CONVENTIONS.md`: money = integer minor units, **never summed across currencies** (per-currency maps); services flush / routers commit; services **clock-free** (`today: date` passed in, router uses `date.today()`); workspace scoping via `scoped_select`/`get_scoped`. Conventional commits, **NO trailers**.
- Frontend: Tailwind `--pc-*`/`--color-*` tokens only (no raw hex); `--pc-positive`/`--pc-negative` for value movement only; Recharts via `web/src/components/ui/chart.tsx` + reuse `ForecastArea`; `MoneyText`/`DateText`; `qk` factory; co-located Vitest; `min-w-0`/`flex-wrap`.
- Base-currency (BRL) primary view. Explainable, no black box: every projected figure decomposes into component deltas.
- **No DB migration** (all inputs already modeled). **Branch `feat/plan-v-forecast` off `main`.** Baseline first: `cd api && uv run pytest -q` and `cd web && npm run build && npm run lint && npm run test` — record, stay green, 0 new warnings. Docker running for the API suite.
- Reuse (do not reinvent): `pecunia.period.month_end`/`shift_month`/`advance`/`next_due_on_or_after`; `ForecastService._cash_start`-style per-currency `AccountService.balance` sum; `AnalyticsService.cashflow`/`committed_monthly`; the band-average basis (`ForecastService._recent_avg_monthly_expense`, `_BAND_LOOKBACK_MONTHS = 6`); `LoanService.remaining_minor`.

---

### Task 1: ProjectionService + `GET /analytics/projection` (backend)

**Files:**
- Create: `api/src/pecunia/services/projection.py`
- Modify: `api/src/pecunia/api/analytics.py` (endpoint + Out schemas)
- Test: `api/tests/test_projection.py`, extend `api/tests/test_analytics.py` (endpoint shape)

**Interfaces — Consumes:** `pecunia.period.{month_end, shift_month, next_due_on_or_after}`; `pecunia.services.recurrence.expand_occurrences`; `AccountService.balance`; `AnalyticsService.cashflow`/`committed_monthly`; models `ScheduledTransaction` (signed amount, income>0/expense<0), `Subscription` (active, amount_minor, billing_frequency, next_renewal, currency), `Loan` (planned_payment_minor/payment_frequency/next_due all set, currency), `BankAccountLink` (+ its `Account.type == "credit_card"`, `provider_balance_minor`, `bill_due_date`), `Transaction` (card_spend_mtd). `current_window`.

**Interfaces — Produces:**
```python
class ProjectionService:
    def __init__(self, db: AsyncSession): ...
    async def project(self, workspace_id: uuid.UUID, *, today: date, months: int = 6) -> dict[str, dict]:
        # months clamped 1..24. Returns {currency: ProjectionOut-shaped dict}:
        # {
        #   "currency": str,
        #   "points": [ {
        #       "date": date,                 # month-end
        #       "optimistic_minor": int,      # running: start + Σ(income − subs − loans − card_bills)
        #       "realistic_minor": int,       # optimistic − cumulative variable
        #       "components": {"income_minor","subscriptions_minor","loans_minor","card_bills_minor","variable_minor"},
        #       "card_bill_labels": [ {"label": str, "amount_minor": int} ],  # this month's card bills, for x-axis annotation
        #   }, ... ],
        #   "runway_months": int | None,      # 1-based index of first month realistic_minor < 0, else None
        #   "runway_until": date | None,      # that month's date, else None
        #   "lowest_point": {"value_minor": int, "date": date},   # min over [start@today, points]; start uses today as date
        #   "recovery": {"date": date, "value_minor": int} | None, # first month realistic goes >=0 after being <0
        #   "variable_lookback_months": int,  # = _BAND_LOOKBACK_MONTHS (6), for the breakdown caption
        # }
```

Algorithm (per currency; mirror `ForecastService.forecast`'s month-end axis `point_dates = [month_end(shift_month(today, i)) for i in range(1, months+1)]`):
- `start[currency]` = Σ `AccountService.balance(account)` over the workspace's accounts, grouped by currency (same as `ForecastService._cash_start`).
- Per month index `i` accumulate components into that month's bucket:
  - income: active `ScheduledTransaction` with `amount_minor > 0`, each occurrence `d` in `expand_occurrences(next_due, frequency, horizon_end, today=today)` landing in month `i` → `income_minor += amount_minor`.
  - subscriptions: active subs, occurrences of `next_renewal`/`billing_frequency` → `subscriptions_minor += amount_minor` (outflow magnitude, positive number).
  - loans: loans with all three fields set, occurrences of `next_due`/`payment_frequency` → `loans_minor += planned_payment_minor`.
  - recurring scheduled EXPENSES (active `ScheduledTransaction` with `amount_minor < 0`): add their magnitude to the `subscriptions_minor` bucket (whose UI label is "assinaturas e recorrentes"). This mirrors how `AnalyticsService.committed_monthly` already groups subscriptions + recurring scheduled expenses under one committed total — one honest committed-outflow bucket, no extra component key. (So the component keys stay exactly: `income_minor`, `subscriptions_minor`, `loans_minor`, `card_bills_minor`, `variable_minor`.)
  - card bills: for each linked credit card, `bill = max(0, abs(provider_balance_minor) − card_spend_mtd)` where `card_spend_mtd` = `-SUM(Transaction.amount_minor)` for that account, `amount_minor < 0`, `transfer_id IS NULL`, `occurred_on` in `[current_month_start, today]`, `deleted_at IS NULL` (identical filter to `SafeToSpendService`); place `bill` in the month index of `next_due_on_or_after(bill_due_date, today)` if that date ≤ horizon_end; `card_bills_minor += bill`, and append `{label: account.name, amount_minor: bill}` to that month's `card_bill_labels`. Each card counted once.
- variable: `band_avg[currency]` = the `_recent_avg_monthly_expense` basis (avg monthly total spend over 6 months − committed_monthly, floored 0). Each month `variable_minor = band_avg` (constant per month).
- Walk: `optimistic = start + Σ_i (income − subscriptions − loans − card_bills)`; `realistic = optimistic − Σ_i variable` (cumulative). Round-free (ints).
- Derived: iterate realistic series (prefixed with `{date: today, value: start}` as index 0 for lowest-point/recovery seeding): `runway_months`/`runway_until` from first realistic<0; `lowest_point` = min over the seeded series; `recovery` = first month realistic≥0 after a prior realistic<0 (None if never negative or never recovers).

**Endpoint:** `GET /api/v1/analytics/projection?months=6` (`ge=1, le=24`), `require_workspace`+`require_initialized`, router passes `today=date.today()`, returns `dict[str, ProjectionOut]`. Define `ProjectionOut`/`ProjectionPoint`/`ProjectionComponents`/`CardBillLabel`/`PointMarker`(value+date)/`Recovery` Pydantic models mirroring the dict.

- [ ] **Step 1: Failing tests** (`test_projection.py`, fixtures per `test_analytics.py`/`test_scheduler.py`): components sum to the net month delta; a card bill lands once in its rolled-due month and lowers both lines + appears in `card_bill_labels`; realistic ≤ optimistic each month and equals optimistic when band_avg=0; a this-month-deficit carries forward (month 1 realistic starts below start by the card bill etc.); `runway_months` None when always ≥0, and the right 1-based index when it dips; `lowest_point` value+date; `recovery` detected after a dip + None when never negative; per-currency isolation; `card_spend_mtd` excludes transfer legs (no double-count); months clamp 1..24; clock-free. Endpoint test: `GET /analytics/projection` returns the per-currency shape.
- [ ] **Step 2–4:** implement; `cd api && uv run pytest tests/test_projection.py tests/test_analytics.py -q` green, then full suite green.
- [ ] **Step 5: Commit** `feat: cash projection service + /analytics/projection`.

---

### Task 2: debt payoffs + `GET /analytics/debt-payoffs` (backend)

**Files:** Create nothing new (add `debt_payoffs` to `ProjectionService` OR a method on `LoanService`); Modify `api/src/pecunia/services/projection.py` + `api/src/pecunia/api/analytics.py`; Test `api/tests/test_projection.py` (or `test_loans.py`).

**Interfaces — Produces:**
```python
async def debt_payoffs(self, workspace_id: uuid.UUID, *, today: date) -> list[dict]:
    # one entry per loan with planned_payment_minor>0 AND payment_frequency AND next_due set:
    # { "loan_id": uuid, "name": str, "remaining_minor": int, "planned_payment_minor": int,
    #   "payment_frequency": str, "currency": str,
    #   "payoff_date": date | None, "payments_left": int | None }
    # Step from next_due via pecunia.period.advance(date, frequency), subtracting
    # planned_payment_minor each step from LoanService.remaining_minor(loan) until <= 0.
    # Cap at 24 months of steps; if not paid within the cap -> payoff_date/payments_left None.
```
Only `borrowed`-direction loans are debts (a `lent` loan is a receivable) — filter to `direction == "borrowed"` (confirm the enum value in `models/loan.py`). Endpoint `GET /api/v1/analytics/debt-payoffs` → `list[DebtPayoutOut]`, same deps, `today` from router.

- [ ] **Step 1: Failing tests:** a borrowed loan with remaining 1000, payment 300 monthly, next_due in 1mo → `payments_left == 4`, `payoff_date` = 4 steps out; a loan with planned_payment 0 / None frequency → excluded; a loan not amortizing within 24mo → payoff_date None; a `lent` loan excluded; per-currency `currency` carried. Endpoint shape test.
- [ ] **Step 2–4:** implement; focused + full suite green.
- [ ] **Step 5: Commit** `feat: loan debt-payoff ETAs + /analytics/debt-payoffs`.

---

### Task 3: Forecast screen shell — route, nav, runway hero, projection chart (frontend)

**Files:**
- Create: `web/src/features/forecast/ForecastScreen.tsx`, `web/src/features/forecast/useForecast.ts` (hooks), `web/src/features/forecast/ProjectionChart.tsx` (+ co-located tests)
- Modify: `web/src/lib/queries.ts` (keys), `web/src/App.tsx` (route `/forecast`), `web/src/components/layout/TabBar.tsx` (6th tab), `web/src/components/layout/AppShell.tsx` (sidebar entry)

**Interfaces — Produces (TS types mirror the backend Out exactly):**
```ts
// queries.ts under qk.analytics:
projection: (months?: number) => months ? ["analytics","projection",{months}] as const : ["analytics","projection"] as const,
debtPayoffs: () => ["analytics","debt-payoffs"] as const,
// useForecast.ts
export interface ProjectionComponents { income_minor:number; subscriptions_minor:number; loans_minor:number; card_bills_minor:number; variable_minor:number }
export interface ProjectionPoint { date:string; optimistic_minor:number; realistic_minor:number; components:ProjectionComponents; card_bill_labels:{label:string;amount_minor:number}[] }
export interface Projection { currency:string; points:ProjectionPoint[]; runway_months:number|null; runway_until:string|null; lowest_point:{value_minor:number;date:string}; recovery:{date:string;value_minor:number}|null; variable_lookback_months:number }
export function useProjection(months: number): UseQueryResult<Record<string, Projection>>  // GET /analytics/projection?months=
export function useDebtPayoffs(): UseQueryResult<DebtPayoff[]>
```

- `ForecastScreen` renders the base-currency `Projection` (from `usePreferences().base_currency`): a **runway hero** (positive copy "Seu caixa fica no azul pelos próximos N meses" when `runway_months === null`, else negative "Seu caixa zera em ~N meses (<DateText runway_until>)"), then `ProjectionChart`, then (Task 4/5 slots). A 6/12 month toggle drives `useProjection(months)`.
- `ProjectionChart` (extend/compose `ForecastArea` or a new `ComposedChart`): realistic line solid (`--pc-*` token), optimistic line dashed+lighter, a zero `ReferenceLine`, a dot/marker on the lowest-point date and the recovery date, x-axis month labels; card-bill months flagged (e.g. a small marker/label). Tokens only; responsive.
- **Nav:** add `{ label: "Previsão", to: "/forecast", end: false, icon: LineChart }` to `TabBar`'s `TABS` (now six) and the matching sidebar nav item in `AppShell`; add the `<Route path="forecast" element={<ForecastScreen/>}>` in `App.tsx`. If six tabs overflow the smallest width in the TabBar test/layout, move `Transações` to the drawer-only (keep it in AppShell sidebar, drop from TABS) — note the choice in the report.

- [ ] **Step 1: Failing Vitest:** hooks call the right endpoints/keys; runway hero shows the positive vs negative copy per `runway_months`; chart renders two series (assert both line datakeys) + zero reference; TabBar renders a "Previsão" tab linking `/forecast` with active state at that route; AppShell sidebar has the entry.
- [ ] **Step 2–4:** implement; `cd web && npm run build && npm run lint && npm run test` green, 0 new warnings; existing TabBar/AppShell tests stay green (augmented).
- [ ] **Step 5: Commit** `feat(web): forecast tab — route, nav, runway hero, projection chart`.

---

### Task 4: Lowest-point & recovery tiles + "o que compõe" breakdown (frontend)

**Files:** Create `web/src/features/forecast/MonthBreakdown.tsx` (+ test); Modify `ForecastScreen.tsx` (+ test), optional `web/src/features/forecast/forecastCopy.ts` for shared formatting.

**Interfaces — Consumes:** the `Projection` from Task 3 (`lowest_point`, `recovery`, `points[].components`, `card_bill_labels`, `variable_lookback_months`).

- Two compact stat tiles below the chart: **Menor saldo** ("−R$X · <DateText lowest_point.date>" + the nearest card-bill label that month if any, e.g. "após fatura BTG"), negative/positive tone by sign; **Recuperação** ("De volta ao azul · <DateText recovery.date>, +R$Y") — hidden entirely when `recovery === null` (and show a reassuring line when the balance never goes negative).
- **MonthBreakdown** ("o que compõe"): for the month selected on the chart (default: the lowest-point month, or month 1), a signed/colored component list from `components`: `+<income>` renda (positive), `−<subscriptions>` assinaturas e recorrentes, `−<loans>` empréstimos, `−<card_bills>` fatura (expand each `card_bill_labels` entry as "fatura <label>"), `−<variable>` variável médio with caption "média de {variable_lookback_months} meses" — ending in "→ saldo <realistic_minor>". Tokens; `MoneyText` with explicit signs. A month is selectable (tap a chart point or a small month switcher).

- [ ] **Step 1: Failing Vitest:** lowest-point tile shows the value+date and the card-bill note when that month has one; recovery tile shown only when `recovery !== null` and hidden otherwise with the all-positive reassurance; MonthBreakdown lists each non-zero component with the right sign/color, the variável-médio caption names the lookback count, and the row sum reconciles to `realistic_minor`.
- [ ] **Step 2–4:** implement; web gate green.
- [ ] **Step 5: Commit** `feat(web): forecast lowest-point/recovery tiles + month breakdown`.

---

### Task 5: Debt-payoff section (frontend)

**Files:** Create `web/src/features/forecast/DebtPayoffList.tsx` (+ test); Modify `ForecastScreen.tsx` (+ test).

**Interfaces — Consumes:** `useDebtPayoffs()` (Task 3 hook) → `DebtPayoff[]` (`loan_id, name, remaining_minor, planned_payment_minor, payment_frequency, currency, payoff_date, payments_left`).

- One row per debt: name, remaining (`MoneyText`), "quitado em <DateText payoff_date>" (or "não quita em 24 meses" when `payoff_date === null`), a caption "`payments_left` × <MoneyText planned_payment_minor>", and a small progress bar (reuse `web/src/features/loans/payoff.ts`'s paid/principal fraction — compute paid = principal − remaining if available, else a remaining-based bar; tokens only). Empty list → hide the section with a one-line "sem dívidas com pagamento programado".

- [ ] **Step 1: Failing Vitest:** a debt with a payoff_date renders the date + "payments_left × payment" + a progress bar; a `payoff_date === null` debt shows "não quita em 24 meses"; empty list hides the section with the one-liner.
- [ ] **Step 2–4:** implement; web gate green.
- [ ] **Step 5: Commit** `feat(web): forecast debt-payoff list`.

---

## Self-review notes
- **Spec coverage:** V-1 engine → Tasks 1 (projection: two lines + card bills + components + runway/lowest/recovery) and 2 (debt payoffs); V-2 screen → Tasks 3 (shell/hero/chart), 4 (tiles + breakdown), 5 (debt list); V-3 nav → Task 3. Breakdown requirement (user's explicit ask) → Task 1 `components`/`card_bill_labels`/`variable_lookback_months` + Task 4 MonthBreakdown.
- **Consistency:** `Projection`/`ProjectionPoint`/`ProjectionComponents` field names identical across Task 1 (backend Out), Task 3 (TS interface), Tasks 4–5 (consumers); `card_spend_mtd` filter identical to SafeToSpendService (incl. `transfer_id IS NULL`, the money-critical fix); `band_avg` basis identical to `ForecastService._recent_avg_monthly_expense`; `next_due_on_or_after` reused for card-bill month placement; `pecunia.period.advance` reused for payoff stepping; realistic = optimistic − cumulative variable, so realistic ≤ optimistic always.
- **Component-split decision (Task 1):** income / subscriptions(+recurring scheduled expenses, labeled "assinaturas e recorrentes") / loans / card_bills / variable — matches how `committed_monthly` already groups committed, keeps the breakdown honest and finite.
- **No duplication:** net-worth trajectory stays on Insights; current-month safe-to-spend on the dashboard; 14/30-day upcoming unchanged. Previsão owns the >1-month cash + debt horizon only.
- **No migration;** no backend change in Tasks 3–5. **Deferred (per spec):** revolving-card amortization, net-worth milestone ETA, what-if sliders, per-category forward projection, horizons >24mo.
