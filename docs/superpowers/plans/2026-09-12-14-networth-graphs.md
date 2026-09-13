# Plan E (v1.1) — Net-Worth Snapshots + Graph Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give Pecunia its analytical payoff — a **net-worth-over-time** graph backed by persisted snapshots, and a **graph suite** that turns the data from A–D into insight: income-vs-spend cashflow (excluding transfers), spending by category, spending by payee, and project spend. This is the track everything else fed into.

**Architecture:** Two backend layers + two frontend layers.
- **Snapshots** (`net_worth_snapshots`): a daily per-currency net-worth figure, captured idempotently (lazy on read + backfilled from history so the graph is useful from day one). Reconstructs historical net worth from transaction history (`Σ initial_balance + tx where occurred_on ≤ D`) + asset valuations (latest `as_of ≤ D`) — the data already exists (accounts, transactions, `AssetValuation`).
- **Analytics** (`/api/v1/analytics/*`): pure aggregation queries over the existing tables, workspace-scoped, currency-grouped (never summed across currencies), excluding soft-deleted transactions and **transfer legs** (`transfer_id IS NULL`) from income/spend.
- **Dashboard graphs** + an **Insights screen** on the web, built on the existing chart primitives (`TimeSeriesChart`, `Sparkline`, `chartMath.ts`) plus two new pure primitives (a bar chart and a donut/breakdown).

**Tech Stack:** no new backend deps; snapshots captured lazily (no scheduler dep — fits the 3-container deploy). No new frontend deps (SVG charts, same as V1).

## Global Constraints
- Follow `docs/CONVENTIONS.md` (layering; services flush/routers commit; §4 money integer minor units — **never sum across currencies**; §6 keyset/period windows via `pecunia/period.py`; §7 events/allowlists; §8 testing/parity; §9 frontend tokens + §9.1 accent rules; charts are pure-math + SVG, tested without rendering, like `chartMath.ts`). Roadmap: Track E (depends on A,B,C,D).
- Income/spend excludes: soft-deleted (`deleted_at IS NULL`) AND transfer legs (`transfer_id IS NULL`). Spending = expense magnitude (`amount_minor < 0`, summed as ABS); income = `amount_minor > 0` non-transfer.
- Snapshots idempotent per `(workspace_id, currency, captured_on)`. Workspace-scoped (D7) + `is_demo` where rows are seeded. Conventional commits, **no trailers**. Baseline at branch start: backend 418 pytest, web 605 vitest green.

---

### Task 1: Net-worth snapshots — model, migration 0010, capture + backfill service, demo history

**Files:** Create `api/src/pecunia/models/net_worth_snapshot.py`; modify `api/src/pecunia/models/__init__.py`, `api/src/pecunia/audit/allowlists.py`, `api/src/pecunia/services/demo.py`, `api/tests/conftest.py`; create `api/src/pecunia/services/snapshots.py`, `api/alembic/versions/0010_net_worth_snapshots.py`; tests `api/tests/test_migration_0010.py`, `api/tests/test_snapshots.py`.

**Interfaces:**
- `NetWorthSnapshot`: `id` uuid PK; `workspace_id` FK→workspaces CASCADE NOT NULL (idx); `captured_on` Date NOT NULL; `currency` String(3) NOT NULL; `net_worth_minor` BigInteger NOT NULL; `is_demo` bool; `created_at`. Unique `(workspace_id, currency, captured_on)`.
- `SnapshotService(db)`:
  - `net_worth_as_of(workspace_id, on_date) -> dict[str, int]` — per-currency net worth at a date = per-currency `Σ (account.initial_balance_minor + Σ non-deleted tx on that account with occurred_on ≤ on_date)` + per-currency `Σ (each non-archived asset's latest valuation with as_of ≤ on_date)`. (Mirror `AccountService.balance` but date-bounded; assets grouped by their currency.)
  - `capture(workspace_id, on_date)` — upsert one snapshot row per currency for `on_date` (idempotent on the unique key).
  - `backfill(workspace_id, *, months=12, today)` — capture snapshots at the last-day-of-month for the last `months` months plus `today` (so a new/real user's graph shows history immediately). Pass `today` in (no forbidden clock in services/tests).
  - `series(workspace_id, currency, *, from_date, to_date) -> list[(date, minor)]` — ordered snapshot series for the graph.

- [ ] **Step 1: Failing tests** — `test_migration_0010.py` (mirror 0009): table + unique `(workspace,currency,captured_on)`; parity clean. `test_snapshots.py`: `net_worth_as_of` reconstructs a known fixture correctly (accounts+tx by date + asset valuation as-of), grouped per currency, excludes soft-deleted tx and archived assets; `capture` is idempotent (second call same date → no dup, updates value); `backfill` writes the expected number of monthly points; series returns ordered points; all workspace-scoped.
- [ ] **Step 2:** verify fail. **Step 3:** implement model + migration + service; allowlist (`net_worth_snapshot` = {id, captured_on, currency, net_worth_minor, is_demo}); `_pg_clean` (delete snapshots before workspaces — no child FKs). Demo: call `backfill(months=12, today=<demo anchor date>)` so the demo dashboard shows a net-worth curve; keep onboard→demo 201 (+ counts shape as before — snapshots out of the asserted `counts` dict).
- [ ] **Step 4:** green (parity + all). **Step 5:** commit `feat: net-worth snapshots — model, migration 0010, capture/backfill service`.

---

### Task 2: Analytics service + endpoints (cashflow, spending-by-category, by-payee, net-worth series)

**Files:** Create `api/src/pecunia/services/analytics.py`, `api/src/pecunia/api/analytics.py`; modify `api/src/pecunia/main.py` (mount); reuse `pecunia/period.py`; tests `api/tests/test_analytics.py`.

**Interfaces (all workspace-scoped, currency-grouped, `from`/`to` date range):**
- `cashflow(workspace_id, *, from_date, to_date, granularity=month) -> per currency: list of {period_start, income_minor, spend_minor}` — income = `Σ amount_minor` for `amount_minor > 0`; spend = `Σ ABS(amount_minor)` for `amount_minor < 0`; BOTH exclude `deleted_at IS NOT NULL` and `transfer_id IS NOT NULL`. Bucket by month (reuse/extend period.py window math).
- `spending_by_category(workspace_id, *, from_date, to_date) -> per currency: list of {category_id, name, color, spend_minor}` — expense magnitude grouped by category (include an "Uncategorized" bucket for null category); exclude transfers + soft-deleted; sorted desc.
- `spending_by_payee(workspace_id, *, from_date, to_date) -> per currency: list of {payee_id, name, spend_minor}` — analogous, by payee.
- `net_worth_series(workspace_id, *, from_date, to_date)` — delegates to `SnapshotService.series` per currency; **lazy-capture today** if today's snapshot is missing before returning (so the latest point is current).
- Endpoints `/api/v1/analytics/{cashflow,spending-by-category,spending-by-payee,net-worth}` (require_workspace, require_initialized), query params `from`, `to` (ISO dates; sensible defaults e.g. last 12 months), optional `granularity`. Return the per-currency structures above.

- [ ] **Step 1: Failing tests:** cashflow buckets income/spend by month and EXCLUDES transfer legs and soft-deleted (assert a transfer pair contributes 0 to both income and spend); spending-by-category groups expenses incl. an Uncategorized bucket, excludes transfers, sorted; spending-by-payee analogous; net-worth series returns snapshot points + lazily captures today; every result is per-currency and never mixes currencies; other-workspace data excluded.
- [ ] **Step 2–4:** implement; parity + full suite green. **Step 5:** commit `feat: analytics service and endpoints (cashflow, spending breakdowns, net-worth series)`.

---

### Task 3: Dashboard graphs (frontend) — net worth over time, income vs spend, spending by category

**Files:** Create `web/src/features/analytics/` (hooks `useCashflow`/`useSpendingByCategory`/`useNetWorthSeries`, chart wrappers), extend `web/src/components/charts/` with pure primitives + math (a `BarChart` for income-vs-spend, a `Donut`/`BreakdownBar` for category share; extend `chartMath.ts`), modify `web/src/features/dashboard/*` to mount the three graphs, `web/src/lib/queries.ts` (`qk.analytics`); tests.

**Interfaces:** `useNetWorthSeries`/`useCashflow`/`useSpendingByCategory` (base-currency by default; the dashboard already knows base currency). Reuse `TimeSeriesChart` for net worth over time (neutral/white line per §9 — a balance-type series, not delta-colored). New pure primitives with `chartMath`-style tested math: an income-vs-spend grouped/paired **bar** per period (income = positive/emerald, spend = negative/coral — value-movement is the sanctioned semantic-color use), and a category **donut/breakdown** using each category's own `color` swatch. All SVG, tokens only, `prefers-reduced-motion`-safe, responsive (`overflow-x:auto` where needed). Empty states when there's no data.

- [ ] **Step 1: Failing tests (vitest):** the new chart math (bucketing/percent/scale) unit-tested pure; the dashboard renders a net-worth line from a mocked series, an income-vs-spend bar set, and a category donut; empty-state when a series is empty; base-currency selection correct.
- [ ] **Step 2–4:** implement; `npm run build && npm run lint && npm run test` green. **Step 5:** commit `feat(web): dashboard graphs — net worth, income vs spend, spending by category`.

---

### Task 4: Insights screen (frontend) — spending by payee, project spend, category trend

**Files:** Create `web/src/features/analytics/InsightsScreen.tsx` (+ its charts/hooks), add a nav entry + route (`AppShell` + router), reuse the Task 3 primitives; tests.

**Interfaces:** a dedicated **Insights** screen (sidebar nav item + route) collecting the fuller graph set: spending-by-payee (bar/breakdown), a per-project spend summary (reuse project actual_minor / a by-project analytics call if cheap, else derive from the projects list), and a spending-by-category trend over time (stacked or multi-line by month) or at least the category donut with a period selector. Include a simple period selector (last 3/6/12 months) shared across the screen. Keep it tokens-only, responsive, with empty states. Don't duplicate the dashboard's three graphs — Insights is the deeper view.

- [ ] **Step 1: Failing tests (vitest):** Insights renders spending-by-payee from a mocked response; the period selector changes the query range; project-spend summary renders; empty states hold; the nav entry routes to it.
- [ ] **Step 2–4:** implement; build/lint/test green. **Step 5:** commit `feat(web): insights screen — spending by payee, project spend, category trend`.

---

## Self-review notes
- **Coverage:** snapshots (reconstructed + captured + backfilled, T1); analytics aggregations excluding transfers/soft-deleted, currency-grouped (T2); dashboard's three headline graphs (T3); the deeper Insights screen (T4). Every A–D feature surfaces: categories→category breakdown, payees→payee breakdown, projects→project spend, transfers→correctly excluded from cashflow, assets+accounts→net worth.
- **Consistency:** aggregations reuse `period.py` and the scoping helpers; charts extend the existing `chartMath`/`TimeSeriesChart` family (pure math, SVG, tokens); never sums across currencies (§4); semantic emerald/coral only for income/spend value-movement.
- **Deployment fit:** no scheduler — snapshots capture lazily on read + backfill on demo/first use; idempotent so repeated reads are cheap.
- **Deferred to F:** visual polish of the charts (lucide, motion), the mobile pass — Track F.
