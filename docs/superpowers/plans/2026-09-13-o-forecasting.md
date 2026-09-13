# Track O (v1.4) — Forecasting Engine + Projected Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Project the next 6 months of **cash balance** and **net worth** per currency from the recurring commitments we already store, and render them as a solid-history → **dashed-projection** line with a shaded uncertainty band.

**Architecture:** A clock-free `ForecastService` expands future occurrences of scheduled transactions, subscription renewals, loan payments and recurring income within the horizon, walks them month-by-month from today's live cash/net-worth, and returns per-currency series flagged `projected`. One read-only endpoint; a reusable recharts treatment draws the dashed tail + band.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest+testcontainers (backend); Vite/React/TS, TanStack Query, recharts@2.15.4, Vitest (frontend).

## Global Constraints
- `docs/CONVENTIONS.md`: money integer minor units, **never cross-currency** (per-currency map, like the other `/analytics/*`); services **flush**, routers **commit**; services **clock-free** (`today: date` from the router); workspace-scoped; tokens-only frontend; respect the mobile work. Conventional commits, **NO trailers**.
- **Establish baseline first:** at branch start run `cd api && uv run pytest -q` and `cd web && source ~/.nvm/nvm.sh && npm run test` and record the counts; the suite must stay green (0 new warnings) at every commit.
- Reuse the existing frequency-advance logic that `ScheduledTransaction`/`Subscription` renewal already uses (find it before writing a new one); reuse `SnapshotService.net_worth_as_of` and `AccountService.balance`.

---

### Task 1: Recurrence expansion helper (pure, clock-free)

**Files:** Create `api/src/pecunia/services/recurrence.py`; Test `api/tests/test_recurrence.py`.

**Interfaces — Produces:** `expand_occurrences(anchor: date, frequency: str, horizon_end: date, *, today: date) -> list[date]` — every occurrence date `d` with `today <= d <= horizon_end`, stepping by frequency (`weekly|monthly|quarterly|yearly`); clamps month arithmetic to valid days (Jan 31 +1mo → Feb 28); returns `[]` when frequency is unknown/None.

- [ ] **Step 1:** Failing tests: monthly from an anchor yields one date per month in-horizon; a past anchor still projects the *upcoming* occurrences only (`>= today`); weekly/quarterly/yearly step correctly; end-of-month clamps; unknown frequency → `[]`.
- [ ] **Step 2:** Run → fail. **Step 3:** Implement using the existing frequency step. **Step 4:** Run → pass.
- [ ] **Step 5:** Commit `feat: recurrence occurrence-expansion helper`.

---

### Task 2: `ForecastService` + `/analytics/forecast` endpoint

**Files:** Create `api/src/pecunia/services/forecast.py`; Modify `api/src/pecunia/api/analytics.py` (add endpoint + Pydantic `ForecastPoint`/response); Test `api/tests/test_forecast.py`, `api/tests/test_analytics.py`.

**Interfaces — Consumes:** `expand_occurrences` (Task 1), `SnapshotService.net_worth_as_of`, `AccountService.balance`. **Produces:**
`ForecastService.forecast(workspace_id, *, today: date, months: int = 6) -> dict[str, dict[str, list[ForecastPoint]]]` keyed `{currency: {"net_worth": [...], "cash": [...]}}`; `ForecastPoint = {date: date, value_minor: int, lower_minor: int, upper_minor: int, projected: bool}`.
- **cash** start = Σ account balances (per currency); each month-end applies expanded scheduled txns (signed), subscription renewals (expense), loan planned payments (cash out), recurring income (in).
- **net_worth** start = `net_worth_as_of(today)`; each month adds Σincome − Σexpense; a **loan principal payment does NOT move net worth** (cash↓ + debt↓), only the cash series — document this.
- **band:** avg monthly non-recurring expense over the last 6 months widens `lower/upper` by ±(avg × month_index).
- Endpoint `GET /api/v1/analytics/forecast?months=6` (`require_workspace`+`require_initialized`; router passes `today=date.today()`; clamp months 1–24).

- [ ] **Step 1:** Failing tests (fixture workspace with a monthly sub, a loan payment, a recurring income): points land in the right months; per-currency isolation (a USD sub never touches BRL); loan payment lowers cash but not net worth; band widens with distance; `months` clamps.
- [ ] **Step 2–4:** implement; suites green.
- [ ] **Step 5:** Commit `feat: forecast service + /analytics/forecast endpoint`.

---

### Task 3: Frontend — projected chart treatment + cash-forecast chart

**Files:** Modify `web/src/features/analytics/useAnalytics.ts` (`useForecast`), `web/src/lib/queries.ts` (`qk.analytics.forecast`); Create a reusable `web/src/features/analytics/ForecastArea.tsx` (solid+dashed line + `lower..upper` `<Area>` band + zero `<ReferenceLine>` for cash); Modify the net-worth-over-time chart (dashboard + `InsightsScreen`) to append the projected tail; add a **Cash forecast** card to `InsightsScreen`; Tests alongside.

**Interfaces — Consumes:** the endpoint from Task 2. **Produces:** `useForecast(months?)`, `<ForecastArea data metric="cash"|"net_worth" />`.

- [ ] **Step 1:** Failing vitest: given a mocked forecast, the chart renders a solid segment over history + a dashed segment over `projected` points + a band; the cash chart shows the zero reference; empty state when no data.
- [ ] **Step 2–4:** `npm run build && lint && test` green (0 warnings).
- [ ] **Step 5:** Commit `feat(web): projected forecast charts (net worth tail + cash forecast)`.

## Self-review notes
- **Coverage:** occurrence expansion (T1); the two projections + endpoint (T2); dashed/band rendering on net-worth + a new cash chart (T3).
- **Consistency:** per-currency (no cross-currency sum); clock-free; reuses net_worth_as_of + account balances + the existing frequency step.
- **Deferred:** income×spend projection (net-worth + cash cover the ask); FX.
