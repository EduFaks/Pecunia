# Track R (v1.4) — Dashboard KPIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Three dashboard tiles — **savings rate** (this month, vs prior), **committed monthly cost** (subscriptions + loan payments + recurring planned, normalized to monthly), and **net-worth change** (Δ vs start of month + top movers) — each per currency.

**Architecture:** One `AnalyticsService.summary(...)` aggregation reusing the existing cashflow + `net_worth_as_of`/`net_worth_components_as_of` + subscription/loan/planned data; a `GET /analytics/summary` endpoint; three small dashboard cards. No new table.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest+testcontainers; Vite/React/TS, TanStack Query, Vitest.

## Global Constraints
- `docs/CONVENTIONS.md`: money integer minor units, **never cross-currency** (per-currency map); services **flush**/routers **commit**; **clock-free** (`today` passed in); workspace-scoped; tokens-only frontend; respect the mobile work. Conventional commits, **NO trailers**.
- **Baseline first:** `cd api && uv run pytest -q` (+ web) — record; stay green (0 new warnings).
- Reuse `period.current_window`, the cashflow computation, `SnapshotService.net_worth_as_of` + `net_worth_components_as_of`, and the same monthly-normalization idea the subscription rollup uses.

---

### Task 1: `AnalyticsService.summary` + `GET /analytics/summary`

**Files:** Modify `api/src/pecunia/services/analytics.py` (add `summary`), `api/src/pecunia/api/analytics.py` (endpoint + Pydantic model); Test `api/tests/test_analytics.py`.

**Interfaces — Produces:** `summary(workspace_id, *, today: date) -> {currency: SummaryOut}` where `SummaryOut = {savings: {income_minor, spend_minor, saved_minor, rate_bps, prev_saved_minor, prev_rate_bps}, committed_monthly: {total_minor, subscriptions_minor, loans_minor, planned_minor}, net_worth_change: {now_minor, start_of_month_minor, delta_minor, pct_bps, movers: [{label, delta_minor}]}}`.
- **savings:** current-month income/spend (reuse cashflow) → `saved = income − spend`, `rate_bps = round(saved/income*10000)` (0 when income 0); plus the prior month's figures for the trend.
- **committed_monthly:** Σ active subscriptions + Σ loan `planned_payment_minor` + Σ recurring planned expenses, each **normalized to monthly** by cycle/frequency (weekly×52/12, monthly×1, quarterly÷3, yearly÷12), per currency.
- **net_worth_change:** `net_worth_as_of(today)` vs `net_worth_as_of(first_of_month)` → delta + `pct_bps`; **movers** = the largest component deltas from `net_worth_components_as_of` at both dates (top 3 by |Δ|).
- Endpoint `GET /api/v1/analytics/summary` (`require_workspace`+`require_initialized`; router passes `today`).

- [ ] **Step 1:** Failing tests (fixture): savings rate + trend sign; monthly normalization of each cycle; net-worth delta/pct and mover ordering; per-currency isolation; income-0 → rate 0.
- [ ] **Step 2–4:** implement; suites green.
- [ ] **Step 5:** Commit `feat: analytics summary (savings rate, committed monthly, net-worth change)`.

---

### Task 2: Frontend — three dashboard KPI tiles

**Files:** Modify `web/src/features/analytics/useAnalytics.ts` (`useSummary`), `web/src/lib/queries.ts`; Create `web/src/features/dashboard/SavingsRateCard.tsx`, `CommittedMonthlyCard.tsx`, `NetWorthChangeCard.tsx`; mount on `web/src/features/dashboard/Dashboard.tsx`; Tests alongside.

**Interfaces — Consumes:** Task 1. Tiles render base-currency figures (currency-selectable like the other analytics hooks), a trend arrow (savings), a breakdown (committed), and the top movers (net-worth change); clean empty states.

- [ ] **Step 1:** Failing vitest per card from a mocked summary: savings shows saved + rate + up/down trend; committed shows total + the 3-way breakdown; change shows Δ/% + movers; empty states.
- [ ] **Step 2–4:** `npm run build && lint && test` green (0 warnings). Keep the dashboard balanced/responsive (mobile).
- [ ] **Step 5:** Commit `feat(web): savings-rate, committed-monthly, net-worth-change dashboard cards`.

## Self-review notes
- **Coverage:** one aggregation with all three metrics (T1); three tiles (T2).
- **Consistency:** per-currency; clock-free; reuses cashflow + net_worth_as_of/components + the subscription monthly-normalization; bps for rates/pcts (integer, no float money).
- **Deferred:** anomaly detection / spending-pace; a bill calendar (bonus, not this track).
