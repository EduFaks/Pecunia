# Track S (v1.4) — Savings Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
>
> **Build order:** this track builds in **Wave 2**, off a `develop` that already contains Track Q (migration `0003`) and Track O (the forecast service). Its migration is `0004` and its ETA consumes `ForecastService`.

**Goal:** A savings-goal domain — a target amount (and optional date) whose progress is derived from a chosen source (an account balance, a portfolio value, net worth, or a manual figure), with an ETA computed from the forecast, shown on a management screen and as a dashboard progress ring.

**Architecture:** A workspace-scoped `goals` table + `GoalService` that resolves current progress from the source and projects an ETA via `ForecastService`; CRUD endpoints; a goals screen + a dashboard ring widget + a nav entry under "Plan".

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, pytest+testcontainers; Vite/React/TS, TanStack Query, Vitest.

## Global Constraints
- `docs/CONVENTIONS.md`: money integer minor units, **never cross-currency** (a goal's currency must equal its source's currency); services **flush**/routers **commit**; **clock-free** (`today` passed in); workspace-scoped; events → audit/activity with an allowlist; StrEnum + CHECK; SQLAlchemy naming convention drives migration names (`compare_metadata` clean). Conventional commits, **NO trailers**.
- **Baseline first:** `cd api && uv run pytest -q` (+ web) — record; stay green (0 new warnings).
- **Migration revision = `0004`, `down_revision="0003"`.** Reuse `AccountService.balance`, portfolio `value_minor`, `SnapshotService.net_worth_as_of`, and `ForecastService.forecast` (Track O).

---

### Task 1: Migration 0004 + `Goal` model

**Files:** Create `api/alembic/versions/0004_goals.py`; Create the `Goal` model + `GoalSourceKind` StrEnum; Test `api/tests/test_migration_0004.py` + model test.

**Interfaces — Produces:** table `goals(id, workspace_id FK, name, target_minor int, currency, target_date date NULL, source_kind {account|portfolio|net_worth|manual} CHECK, source_id uuid NULL, manual_current_minor int NULL, created_at)`.

- [ ] **Step 1:** Failing test: `upgrade` creates `goals` with the CHECK on `source_kind`; `compare_metadata` clean; `downgrade` drops it; round-trip a row.
- [ ] **Step 2:** model + hand-written migration (`revision="0004"`, `down_revision="0003"`). **Step 3–4:** green.
- [ ] **Step 5:** Commit `feat: goals table + model (migration 0004)`.

---

### Task 2: `GoalService` (CRUD + progress + ETA) + endpoints

**Files:** Create `api/src/pecunia/services/goals.py`, `api/src/pecunia/api/goals.py` (router, mounted in the app); Test `api/tests/test_goals.py`.

**Interfaces — Consumes:** `AccountService.balance`, portfolio `value_minor`, `net_worth_as_of`, `ForecastService.forecast`. **Produces:**
- CRUD (`create/get/list/update/delete`), validating **currency == source currency** for account/portfolio sources (else 422 `GOAL_CURRENCY_MISMATCH`) and that `source_id` resolves (404 on a missing account/portfolio).
- `progress(goal, *, today) -> {current_minor, target_minor, pct_bps}` resolving current from the source (`manual` → `manual_current_minor`; `net_worth` → `net_worth_as_of`).
- `eta(goal, *, today) -> {reached_on: date | None, on_track: bool}` — walk the forecast of the source currency until `current >= target` within the horizon; `None`/`on_track=false` if never in horizon.
- `GoalOut` includes `progress` + `eta`. Endpoints under `/api/v1/goals` (router passes `today`, commits).

- [ ] **Step 1:** Failing tests: progress for each source kind; currency-mismatch rejected; ETA reaches target from a projected fixture (on-track) and returns not-on-track when it never reaches; CRUD + workspace scoping.
- [ ] **Step 2–4:** implement; suites green.
- [ ] **Step 5:** Commit `feat: goals service + CRUD/progress/ETA endpoints`.

---

### Task 3: Frontend — goals screen + dashboard ring + nav

**Files:** Create `web/src/features/goals/useGoals.ts`, `GoalsScreen.tsx`, `GoalForm.tsx`, and a `GoalRing.tsx` widget; mount the route in `App.tsx`; add a **Goals** nav item under "Plan" in `web/src/components/layout/AppShell.tsx`; mount a goals summary on `Dashboard.tsx`; `web/src/lib/queries.ts` (`qk.goals`); Tests alongside.

**Interfaces — Consumes:** Task 2 endpoints. Screen: list with a progress ring + ETA line per goal, create/edit/delete with a **source selector** (account / portfolio / net worth / manual, currency auto-filled/validated). Dashboard: the top goals' rings.

- [ ] **Step 1:** Failing vitest: the ring renders `pct` + target from a mocked goal; the ETA line shows the reached month or "not on track"; the form's source selector switches inputs (hides manual amount unless `manual`); nav shows Goals.
- [ ] **Step 2–4:** `npm run build && lint && test` green (0 warnings); responsive/mobile.
- [ ] **Step 5:** Commit `feat(web): savings goals screen + dashboard ring`.

## Self-review notes
- **Coverage:** table (T1); service progress/ETA + CRUD (T2); screen + ring + nav (T3).
- **Consistency:** currency == source currency (never cross-currency); clock-free; ETA reuses Track O; events→audit like the other domains.
- **Deferred:** a contributions/deposit ledger (progress is derived from the source, not a separate log); recurring auto-contributions.
