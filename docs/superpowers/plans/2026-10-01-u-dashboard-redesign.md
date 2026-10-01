# Track U (v1.6) — Daily Dashboard Redesign + Mobile PWA Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard a glance-first daily view anchored on a new "safe-to-spend this month" metric, add a native-feeling mobile PWA shell (bottom tab bar, safe-area, pull-to-refresh), move the richer widgets to Insights, and restyle toward a minimalist high-end dark aesthetic.

**Architecture:** One new backend read metric (`SafeToSpendService` + `GET /analytics/safe-to-spend`) reusing the existing cashflow/committed-monthly/recurrence-expansion building blocks; a small settings-write path for an optional monthly budget; a rebuilt `Dashboard.tsx` composed of five focused card components fed by existing + the new endpoint; `AppShell` gains a bottom `TabBar` with safe-area insets and the dashboard gets pull-to-refresh; a token-level restyle.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic (no migration this track), pytest+testcontainers; Vite/React/TS, TanStack Query, Recharts, Vitest + Testing Library, Tailwind v4.

## Global Constraints

- `docs/CONVENTIONS.md`: money = integer minor units, **never summed across currencies** (every analytics figure is a per-currency map); services **flush**, routers **commit**; services **clock-free** (`today: date` passed from the router via `date.today()`); workspace-scoped reads via `scoped_select`; StrEnum+CHECK where enums are added (none here). Conventional commits, **NO trailers**.
- Dashboard renders the **base currency** (`instance_state.settings.base_currency`, default `"BRL"`); other currencies shown compactly, never summed in.
- Frontend: Tailwind v4 `--pc-*`/`--color-*` tokens only (no raw hex); Recharts via `web/src/components/ui/chart.tsx`; TanStack Query with the `qk` factory in `web/src/lib/queries.ts`; money/dates via `MoneyText`/`DateText` (`web/src/lib/preferences.tsx`), hero figures `variant="hero"`. Mobile rules: 16px inputs, `min-w-0`, `overflow-x-auto`, `flex-wrap`, `env(safe-area-inset-*)`.
- **Baseline first:** `cd api && uv run pytest -q` (currently 839) and `cd web && npm run build && npm run lint && npm run test` (currently ~982) — record counts, stay green, 0 new warnings.
- **No DB migration** this track: the monthly budget lives in the existing `instance_state.settings` JSONB.
- Branch `feat/plan-u-dashboard` off `main`.

---

### Task 1: Monthly budget setting (backend write path)

**Files:**
- Modify: `api/src/pecunia/api/settings.py` (**create** this router file), `api/src/pecunia/main.py` (register router), `api/src/pecunia/audit/allowlists.py` (add `monthly_budget_minor` to the `"settings"` set)
- Test: `api/tests/test_settings_api.py` (create)

**Interfaces — Produces:** A workspace-scoped write path for the optional monthly budget, stored at `instance_state.settings["monthly_budget_minor"]` (int minor units, base currency; `null`/absent = unset). Read is already exposed via `GET /auth/me` → `preferences` (which returns `state.settings` verbatim). Router: `router = APIRouter(prefix="/settings", tags=["settings"])`, registered under `/api/v1`.
- `PUT /api/v1/settings/monthly-budget` body `MonthlyBudgetIn{monthly_budget_minor: int | None}` (Field `ge=0` when not None) → 200 `MonthlyBudgetOut{monthly_budget_minor: int | None}`. `Depends(require_workspace)` + `get_db`, commits once. Reads the `InstanceState` singleton (id=1), merges the key into a copy of `.settings` (preserving all other keys), reassigns `state.settings`, flushes, emits `Actions.SETTINGS_UPDATED` with `after=project("settings", {...merged...})`, commits.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_settings_api.py
async def test_put_monthly_budget_persists_and_round_trips(client, initialized_instance):
    r = await client.put("/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 500000})
    assert r.status_code == 200
    assert r.json()["monthly_budget_minor"] == 500000
    me = await client.get("/api/v1/auth/me")
    assert me.json()["preferences"]["monthly_budget_minor"] == 500000

async def test_put_monthly_budget_null_clears_it(client, initialized_instance):
    await client.put("/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 500000})
    r = await client.put("/api/v1/settings/monthly-budget", json={"monthly_budget_minor": None})
    assert r.status_code == 200
    assert r.json()["monthly_budget_minor"] is None

async def test_put_monthly_budget_preserves_other_settings(client, initialized_instance):
    await client.put("/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 500000})
    me = await client.get("/api/v1/auth/me")
    # base_currency seeded by initialized_instance survives the merge
    assert me.json()["preferences"]["base_currency"] == "BRL"

async def test_put_monthly_budget_negative_rejected(client, initialized_instance):
    r = await client.put("/api/v1/settings/monthly-budget", json={"monthly_budget_minor": -1})
    assert r.status_code == 422

async def test_put_monthly_budget_requires_auth(client):
    r = await client.put("/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 1})
    assert r.status_code in (401, 403)
```

- [ ] **Step 2: Run** `cd api && uv run pytest tests/test_settings_api.py -q` → FAIL (no router).

- [ ] **Step 3: Implement**

```python
# api/src/pecunia/api/settings.py
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.auth.deps import WorkspaceContext, require_workspace
from pecunia.db import get_db
from pecunia.events import DomainEvent, event_bus
from pecunia.models import InstanceState

router = APIRouter(prefix="/settings", tags=["settings"])


class MonthlyBudgetIn(BaseModel):
    monthly_budget_minor: int | None = Field(default=None, ge=0)


class MonthlyBudgetOut(BaseModel):
    monthly_budget_minor: int | None


@router.put("/monthly-budget")
async def set_monthly_budget(
    body: MonthlyBudgetIn,
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> MonthlyBudgetOut:
    state = (await db.execute(select(InstanceState).where(InstanceState.id == 1))).scalar_one()
    merged = dict(state.settings or {})
    if body.monthly_budget_minor is None:
        merged.pop("monthly_budget_minor", None)
    else:
        merged["monthly_budget_minor"] = body.monthly_budget_minor
    state.settings = merged
    await db.flush()
    await event_bus.publish(
        db,
        DomainEvent(
            action=Actions.SETTINGS_UPDATED,
            resource_type="settings",
            resource_id="1",
            workspace_id=wsctx.workspace_id,
            after=project("settings", merged),
        ),
    )
    await db.commit()
    return MonthlyBudgetOut(monthly_budget_minor=merged.get("monthly_budget_minor"))
```

Confirm the exact import paths against the codebase before running (`WorkspaceContext`/`require_workspace` location, `InstanceState` export, `get_db`); adjust imports to match siblings like `api/src/pecunia/api/banksync.py`. Add to `allowlists.py` the `"settings"` frozenset: include `"monthly_budget_minor"`. Register in `main.py`: `from pecunia.api.settings import router as settings_router` + `app.include_router(settings_router, prefix="/api/v1")`.

- [ ] **Step 4: Run** `cd api && uv run pytest tests/test_settings_api.py -q` → PASS; then full `uv run pytest -q` green.
- [ ] **Step 5: Commit** `feat: monthly budget setting (PUT /settings/monthly-budget)`.

---

### Task 2: Safe-to-spend metric + endpoint (backend)

**Files:**
- Create: `api/src/pecunia/services/safe_to_spend.py`
- Modify: `api/src/pecunia/api/analytics.py` (add endpoint + Out schema)
- Test: `api/tests/test_safe_to_spend.py` (create), extend `api/tests/test_analytics.py` for the endpoint

**Interfaces — Consumes:** `AnalyticsService.cashflow(workspace_id, *, from_date, to_date)` (per-currency `[{period_start, income_minor, spend_minor}]`); `AnalyticsService.committed_monthly` (not used directly — we expand occurrences for the *remaining* window instead); `pecunia.services.recurrence.expand_occurrences(anchor, frequency, horizon_end, *, today)`; models `ScheduledTransaction` (signed `amount_minor`, `frequency`, `next_due`, `is_active`, `currency`), `Subscription` (`amount_minor`, `billing_frequency`, `next_renewal`, `status=="active"`, `currency`), `Loan` (`planned_payment_minor`, `payment_frequency`, `next_due`, `currency`); `pecunia.period.current_window("monthly", today)` → `(start, end)`; `InstanceState.settings["monthly_budget_minor"]` and `["base_currency"]`.

**Interfaces — Produces:**
```python
class SafeToSpendService:
    def __init__(self, db: AsyncSession): ...
    async def compute(self, workspace_id: uuid.UUID, *, today: date) -> dict[str, dict]:
        # {currency: {safe_minor, displayed_safe_minor, limited_by,
        #   expected_income_minor, committed_remaining_minor, spent_mtd_minor,
        #   monthly_budget_minor, days_remaining, daily_allowance_minor}}
```
Semantics per currency, current calendar month `[month_start, month_end]`:
- `income_mtd`, `spent_mtd` = current-month `income_minor`/`spend_minor` from one `cashflow` call `from_date=month_start, to_date=today`.
- `scheduled_income_remaining` = Σ `st.amount_minor` for active `ScheduledTransaction` with `amount_minor > 0`, over occurrences `d` in `expand_occurrences(st.next_due, st.frequency, month_end, today=today)` **filtered to `d > today`**.
- `committed_remaining` = Σ over the remaining window `(today, month_end]` of: active-subscription renewals (`sub.amount_minor` per occurrence), loan planned payments (`loan.planned_payment_minor`), and active recurring **expense** scheduled txns (`abs(st.amount_minor)` for `amount_minor < 0`). Use the same `d > today` filter. (Loans require `next_due`/`planned_payment_minor`/`payment_frequency` all set — mirror `committed_monthly`'s filter.)
- `expected_income = income_mtd + scheduled_income_remaining`.
- `safe_minor = expected_income - committed_remaining - spent_mtd`.
- `monthly_budget_minor` = `InstanceState.settings["monthly_budget_minor"]` **only for the base currency** (None for others).
- `budget_remaining = monthly_budget_minor - spent_mtd` when the budget is set.
- `displayed_safe_minor = min(safe_minor, budget_remaining)` when budget set, else `safe_minor`; `limited_by = "budget"` if the budget bound won (set and `budget_remaining < safe_minor`), else `"income"`.
- `days_remaining = (month_end - today).days + 1` (always ≥ 1).
- `daily_allowance_minor = max(0, displayed_safe_minor) // days_remaining`.
- Currencies = union of currencies seen in cashflow + any commitment source; a currency with only commitments still gets an entry (income/spent 0). Base currency always gets an entry even if everything is zero (so the hero always renders).

**Endpoint:** `GET /api/v1/analytics/safe-to-spend` → `dict[str, SafeToSpendOut]`, `Depends(require_initialized)`, router passes `today=date.today()`. `SafeToSpendOut` mirrors the dict fields with `limited_by: Literal["income","budget"]`.

- [ ] **Step 1: Write the failing tests** (fixtures: `initialized_instance` gives a BRL workspace; create accounts/transactions/scheduled/subscriptions/loans via existing factories or direct model inserts as other analytics tests do — follow `api/tests/test_analytics.py` patterns). Cover:

```python
# core formula, no budget
async def test_safe_to_spend_core_formula(db, initialized_instance):
    # Arrange: BRL account; income tx +300000 MTD; expense tx -100000 MTD;
    # one active scheduled income +50000 due later this month;
    # one active subscription -20000 renewing later this month.
    # expected_income = 300000 + 50000 = 350000
    # committed_remaining = 20000 ; spent_mtd = 100000
    # safe = 350000 - 20000 - 100000 = 230000
    svc = SafeToSpendService(db)
    out = await svc.compute(ws_id, today=some_mid_month_date)
    brl = out["BRL"]
    assert brl["expected_income_minor"] == 350000
    assert brl["committed_remaining_minor"] == 20000
    assert brl["spent_mtd_minor"] == 100000
    assert brl["safe_minor"] == 230000
    assert brl["displayed_safe_minor"] == 230000
    assert brl["limited_by"] == "income"

async def test_already_due_commitments_not_double_counted(db, initialized_instance):
    # A subscription whose renewal was earlier THIS month (d <= today) must NOT
    # appear in committed_remaining (it is already inside spent_mtd if paid).
    ...
    assert out["BRL"]["committed_remaining_minor"] == 0

async def test_budget_cap_binds(db, initialized_instance):
    # settings.monthly_budget_minor = 150000, spent_mtd = 100000 ->
    # budget_remaining = 50000 < safe(230000) -> displayed = 50000, limited_by budget
    ...
    assert out["BRL"]["displayed_safe_minor"] == 50000
    assert out["BRL"]["limited_by"] == "budget"

async def test_days_remaining_and_daily_allowance_last_day(db, initialized_instance):
    # today == month_end -> days_remaining == 1, no ZeroDivisionError
    out = await svc.compute(ws_id, today=last_day_of_month)
    assert out["BRL"]["days_remaining"] == 1
    assert out["BRL"]["daily_allowance_minor"] == max(0, out["BRL"]["displayed_safe_minor"])

async def test_per_currency_isolation(db, initialized_instance):
    # A USD subscription must not bleed into BRL; budget only applies to base (BRL).
    ...
    assert out["USD"]["monthly_budget_minor"] is None

async def test_base_currency_always_present_when_empty(db, initialized_instance):
    out = await svc.compute(ws_id_with_no_data, today=any_date)
    assert "BRL" in out and out["BRL"]["safe_minor"] == 0
```

Plus an endpoint test in `test_analytics.py`: `GET /analytics/safe-to-spend` returns 200 with the per-currency shape and the base-currency key present.

- [ ] **Step 2: Run** `cd api && uv run pytest tests/test_safe_to_spend.py -q` → FAIL.
- [ ] **Step 3: Implement** `SafeToSpendService` per the semantics above (clock-free; `scoped_select` for every read; one `cashflow` call for MTD; `expand_occurrences` with `d > today` filter for the remaining window; read `InstanceState.settings` for budget + base currency). Add the endpoint + `SafeToSpendOut` to `analytics.py`, router passing `today=date.today()`.
- [ ] **Step 4: Run** `cd api && uv run pytest tests/test_safe_to_spend.py tests/test_analytics.py -q` → PASS; then full `uv run pytest -q` green.
- [ ] **Step 5: Commit** `feat: safe-to-spend analytics metric + endpoint`.

---

### Task 3: SafeToSpendCard (frontend hero) + hooks

**Files:**
- Create: `web/src/features/dashboard/SafeToSpendCard.tsx` (+ `.test.tsx`), `web/src/features/dashboard/useDashboard.ts` (hooks)
- Modify: `web/src/lib/queries.ts` (add `qk.analytics.safeToSpend()` + a `monthlyBudget` mutation key note)

**Interfaces — Consumes:** `GET /analytics/safe-to-spend`, `PUT /settings/monthly-budget`, `usePreferences()` for base currency + current `monthly_budget_minor`. **Produces:**
```ts
// queries.ts (under qk.analytics)
safeToSpend: () => ["analytics", "safe-to-spend"] as const,
// useDashboard.ts
export interface SafeToSpend { safe_minor:number; displayed_safe_minor:number;
  limited_by:"income"|"budget"; expected_income_minor:number; committed_remaining_minor:number;
  spent_mtd_minor:number; monthly_budget_minor:number|null; days_remaining:number; daily_allowance_minor:number }
export function useSafeToSpend(): UseQueryResult<Record<string, SafeToSpend>>  // GET, key qk.analytics.safeToSpend()
export function useSetMonthlyBudget(): UseMutationResult // PUT /settings/monthly-budget; onSuccess invalidate qk.analytics + ["auth","me"]
```

`SafeToSpendCard` renders the **base currency** entry: month name + `days_remaining` ("faltam N dias"); `displayed_safe_minor` via `MoneyText variant="hero"` with the label "livre pra gastar"; a progress bar of `spent_mtd_minor` against the ceiling `spent_mtd_minor + max(0, displayed_safe_minor)` (clamp 0–100%); `daily_allowance_minor` as "~<money>/dia"; a one-line breakdown ("renda <expected_income> · fixos a vir <committed_remaining> · gasto <spent_mtd>"); when `limited_by === "budget"`, a subtle note "limitado pelo orçamento". A small "definir orçamento" / edit affordance opens an inline number input that calls `useSetMonthlyBudget` (empty clears it). Tokens only; `min-w-0`, `flex-wrap`; negative `displayed_safe` shows in `--pc-negative` ("você passou do limite").

- [ ] **Step 1: Failing Vitest** (`vi.mock("../../lib/api", …)` seam): renders the hero figure from a mocked response; shows "limitado pelo orçamento" only when `limited_by==="budget"`; the breakdown numbers render; setting a budget calls `apiFetch("/settings/monthly-budget", {method:"PUT", body: {monthly_budget_minor: …}})`; empty submit sends `null`; daily allowance text present.
- [ ] **Step 2–4:** implement; `cd web && npm run build && npm run lint && npm run test` green, 0 new warnings.
- [ ] **Step 5: Commit** `feat(web): safe-to-spend hero card + budget setting`.

---

### Task 4: MonthResultCard + SpendingBreakdownCard

**Files:**
- Create: `web/src/features/dashboard/MonthResultCard.tsx`, `web/src/features/dashboard/SpendingBreakdownCard.tsx` (+ `.test.tsx` each)
- Modify: `web/src/features/dashboard/useDashboard.ts` if a thin wrapper hook helps (reuse existing `useSummary`, `useForecast`, `useSpendingByCategory`, `useCashflow`)

**Interfaces — Consumes:** existing `useSummary()` (`savings.income_minor/spend_minor` MTD), `useForecast()` (current-currency `cash` series — the last point of the current month is the projected end-of-month cash; its delta-from-now direction drives the surplus/deficit sign), `useSpendingByCategory()` (per-currency donut data), `useCashflow()` (current vs previous month totals for the ↑/↓ comparison). **Produces:** two self-contained cards for the base currency.

- `MonthResultCard`: "Entrou <income_mtd>" / "Saiu <spend_mtd>" (from `useSummary`); "Projeção fim do mês: <signed>" where the projection = `expected_income − (spent_mtd + committed_remaining + projected_variable_remainder)`; **reuse the SafeToSpend response** (`useSafeToSpend`) for `expected_income`/`committed_remaining`/`spent_mtd`, and the forecast band center for `projected_variable_remainder` — OR, simpler and self-consistent: projection = `displayed-independent`: `expected_income_minor − committed_remaining_minor − (spent_mtd_minor + avg_daily_variable × days_remaining)`. Pick the SafeToSpend-derived form to avoid a second source of truth; green/red via `--pc-positive`/`--pc-negative`.
- `SpendingBreakdownCard`: reuse `CategoryChart` donut + month total + "↑/↓ X% vs mês passado" computed from `useCashflow` current vs previous `spend_minor`.

- [ ] **Step 1: Failing Vitest** for each: MonthResult shows entrou/saiu and a signed projection with the right color from mocked responses; SpendingBreakdown renders the donut (Recharts stubbed as today) + total + the vs-last-month delta sign.
- [ ] **Step 2–4:** implement; web gate green.
- [ ] **Step 5: Commit** `feat(web): month-result and spending-breakdown cards`.

---

### Task 5: UpcomingCard + AccountsCardsCard

**Files:**
- Create: `web/src/features/dashboard/UpcomingCard.tsx`, `web/src/features/dashboard/AccountsCardsCard.tsx` (+ `.test.tsx` each)

**Interfaces — Consumes:** `useUpcoming()` (`/analytics/upcoming` → `{due:[{kind,label,due_on,amount_minor,currency,direction}], over_budget:[…]}`); `useBankConnections()` (`/bank-sync/connections` → connections with `links:[{account_id,account_name,account_currency,provider_balance_minor,derived_balance_minor,credit_limit_minor,bill_close_date,bill_due_date}]`); the dashboard-suffixed accounts read (`/accounts?limit=200`) for non-synced accounts. **Produces:** two cards.

- `UpcomingCard`: next ~14 days (`within_days=14`), compact rows `DateText(due_on) · label · MoneyText(signed amount)`; receivables (`direction` income) in positive tone, bills negative; empty state "nada nos próximos 14 dias".
- `AccountsCardsCard`: list accounts with balance (`MoneyText`); for accounts that have a bank link, show an "Open Finance" chip; for credit cards, a used/limit bar (`abs(derived_balance_minor)` of `credit_limit_minor`) and "vence <bill_due_date>". Join accounts↔links by `account_id`. Non-synced accounts render balance only.

- [ ] **Step 1: Failing Vitest:** UpcomingCard renders rows sorted by date with correct sign/tone and the empty state; AccountsCardsCard shows a card's used/limit bar + due date for a linked credit card and a plain balance for an unlinked account.
- [ ] **Step 2–4:** implement; web gate green.
- [ ] **Step 5: Commit** `feat(web): upcoming and accounts/cards dashboard cards`.

---

### Task 6: Dashboard assembly + move widgets to Insights

**Files:**
- Modify: `web/src/features/dashboard/Dashboard.tsx` (rewrite as the lean card stack), `web/src/features/analytics/InsightsScreen.tsx` (receive the moved widgets), `web/src/features/dashboard/Dashboard.test.tsx`
- Likely move/extract: the inline `CashflowChart` (Dashboard.tsx:97-163) into `web/src/features/analytics/CashflowChart.tsx` if Insights needs it; the existing dashboard-only widgets (`BalanceTiles`, `SavingsRateCard`, `CommittedMonthlyCard`, `NetWorthChangeCard`, `ForecastArea` net-worth, `GoalsWidget`, `RecentActivity`, `AccountsSnapshot`) are relocated to Insights (import there) and removed from the dashboard.

**Interfaces — Consumes:** Tasks 3–5 cards. **Produces:** the new `Dashboard.tsx` = vertical stack: `SafeToSpendCard` → `MonthResultCard` → `SpendingBreakdownCard` → `UpcomingCard` → `AccountsCardsCard`, each `min-w-0`, stacked `flex flex-col gap-6`, with the existing loading/error/empty guards. Insights keeps hosting net-worth-over-time + forecast, composition, KPIs, goals, activity (add any that were dashboard-only: `GoalsWidget`, `RecentActivity` — ensure they now render on Insights).

- [ ] **Step 1: Failing Vitest:** Dashboard renders the five new cards in order and NOT the moved widgets (e.g. `queryByText(/net worth over time/i)` is null on the dashboard); Insights renders the moved widgets (goals, activity, net-worth chart). Keep existing Insights tests green.
- [ ] **Step 2–4:** implement; web gate green; verify no dangling imports / dead components.
- [ ] **Step 5: Commit** `feat(web): assemble daily dashboard, move rich widgets to Insights`.

---

### Task 7: Mobile shell — bottom TabBar + safe-area + pull-to-refresh

**Files:**
- Create: `web/src/components/layout/TabBar.tsx` (+ `.test.tsx`), `web/src/components/layout/usePullToRefresh.ts` (+ `.test.ts`)
- Modify: `web/src/components/layout/AppShell.tsx` (render TabBar below `md`, add bottom padding for safe-area), `web/index.html` (viewport `viewport-fit=cover`), `web/src/features/dashboard/Dashboard.tsx` (wire pull-to-refresh)

**Interfaces — Produces:**
- `TabBar`: fixed bottom bar, `md:hidden` (desktop keeps the sidebar). Tabs (lucide icons + labels): Dashboard `/` (end), Transações `/transactions`, Insights `/insights`, Contas `/accounts`, Settings `/settings`. Active via `NavLink` `aria-current="page"`. Container padded `pb-[env(safe-area-inset-bottom)]`; height token-consistent. `AppShell` main content gets `pb-24 md:pb-8` (clear the bar) and the bar sits above content with a hairline top border + surface background.
- `usePullToRefresh({ onRefresh }: { onRefresh: () => Promise<void> })` → `{ bind, refreshing }`: a touch handler bound to the dashboard scroll container that, when the container is at `scrollTop===0` and the user pulls down past a threshold (~64px), calls `onRefresh` and shows `refreshing` until it resolves. Pointer/touch events only; no-op on desktop (mouse). Dashboard's `onRefresh` invalidates `qk.analytics` + the dashboard-suffixed account/bank keys via the query client.

- [ ] **Step 1: Failing tests:** `TabBar` renders 5 links with correct `href`s and marks the active one (`render` at `/transactions` → that tab `aria-current="page"`); it is `md:hidden` (assert the class). `usePullToRefresh` test (jsdom): simulate touchstart at top + touchmove past threshold + touchend → `onRefresh` called once and `refreshing` toggles. Dashboard test: pulling triggers the query invalidations (mock the query client / `onRefresh`).
- [ ] **Step 2–4:** implement; web gate green. Verify desktop (≥md) still shows the sidebar and hides the TabBar (existing AppShell tests stay green).
- [ ] **Step 5: Commit** `feat(web): mobile bottom tab bar, safe-area, pull-to-refresh`.

---

### Task 8: Restyle — minimalist high-end dark

**Files:**
- Modify: `web/src/styles/tokens.css`, `web/src/styles/global.css`, shared components `web/src/components/ui/Card.tsx` / `Surface.tsx` / `SummaryHeader.tsx`, and the dashboard card components for spacing/hierarchy polish
- Test: visual/token-level — extend existing component tests only where class assertions already exist; no new brittle snapshot tests

**Interfaces — Produces:** a tuned token set that lands app-wide: near-black canvas (keep `#0a0a0b`), elevated surfaces with hairline borders, increased spacing scale and typographic hierarchy, a single restrained accent (`--pc-accent`) for emphasis, semantic emerald/coral strictly for value movement. Hero card gets a subtle elevation/glow (one place only). Micro-interactions use the existing `ease-pc`. Keep (or confirm) light-theme readability; if the app is dark-only, note it and keep.

- [ ] **Step 1:** Establish the baseline — `cd web && npm run build && npm run lint && npm run test` green before touching tokens. Note current token values you change (record old→new in the commit body is fine, but NO trailers).
- [ ] **Step 2–3:** Apply token/shared-component changes; keep all existing tests green (fix any class-based assertions that legitimately change, without weakening them). Do not introduce raw hex in components — only token references.
- [ ] **Step 4:** `npm run build && npm run lint && npm run test` green, 0 new warnings. Manually sanity-check the dashboard renders (describe in the report; a screenshot via the `run`/browser tooling is a plus but not required).
- [ ] **Step 5: Commit** `feat(web): restyle toward minimalist high-end dark`.

---

## Self-review notes

- **Spec coverage:** U1 safe-to-spend → Tasks 1 (budget storage) + 2 (metric/endpoint); U2 dashboard cards → Tasks 3,4,5; dashboard assembly + move-to-Insights → Task 6; U3 mobile shell → Task 7; U4 restyle → Task 8. All five locked decisions covered.
- **Consistency:** `SafeToSpend` field names identical across Task 2 (backend Out), Task 3 (TS interface), and Task 4 (reused for the projection); `qk.analytics.safeToSpend()` defined in Task 3 and reused in Task 4; `useBankConnections`/`BankLinkOut` fields match Track T's shipped shape (Task 5). The month projection in Task 4 reuses the SafeToSpend response rather than introducing a second computation.
- **No migration:** budget stored in `instance_state.settings`; confirmed there is no existing preferences-write endpoint, hence Task 1 creates the minimal one.
- **Deferred (per spec):** multi-currency budgets, offline service worker, push notifications, per-category budget rollup into the ceiling, transaction↔commitment linkage.
