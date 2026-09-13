# Track K (v1.2) — Net-Worth Composition Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show *what* net worth is made of, over time — a **stacked-area** chart of **cash (accounts) · assets · investments (portfolio) · −debts (loans)** per month. Complements the existing net-worth total line; lives on the **Insights** screen (the deeper-analysis home).

**Architecture:** No new storage/migration — reconstruct components at each month-end from the existing data (the same machinery `net_worth_as_of` already uses: accounts+tx, asset valuations, holdings, loan remaining). Add `net_worth_components_as_of(on_date)` (four accumulators instead of one) + a composition **series** endpoint; render a shadcn/Recharts stacked `AreaChart`.

## Global Constraints
- Follow `docs/CONVENTIONS.md` (§4 money integer minor units, NEVER cross-currency; clock-free services — dates passed in; §9 tokens + charts use the vibrant `--chart-*` palette; §9.1 semantic colors). Conventional commits, **no trailers**. Baseline at branch start: backend 655 pytest, web 785 vitest.

---

### Task 1: Backend — component breakdown + composition series endpoint

**Files:** `api/src/pecunia/services/snapshots.py` (add `net_worth_components_as_of`) + `api/src/pecunia/services/analytics.py` (composition series) + `api/src/pecunia/api/analytics.py` (endpoint); tests `api/tests/test_snapshots.py` + `test_analytics.py`.

**Interfaces:**
- `SnapshotService.net_worth_components_as_of(workspace_id, on_date) -> dict[currency, {cash_minor, assets_minor, investments_minor, debts_minor}]` — the SAME four computations `net_worth_as_of` does, but kept SEPARATE instead of summed into one accumulator: `cash_minor` = accounts (initial + non-deleted tx `occurred_on ≤ on_date`) by account currency; `assets_minor` = each asset's latest valuation `as_of ≤ on_date`; `investments_minor` = Σ `round(qty × latest holding price ≤ on_date)` by portfolio currency; `debts_minor` = Σ over loans of the signed remaining (borrowed −remaining, lent +remaining) — **as a signed net-debt term** (so a stacked area places it below zero for net liabilities). Keep `net_worth_as_of` working (either refactor it to call this and sum, or leave it and add the parallel method — prefer refactor so total == Σ components exactly, and assert that in a test). Per currency, never cross-currency; a currency with no activity in a bucket contributes 0 for that bucket (only emit currencies that appear).
- `AnalyticsService.net_worth_composition(workspace_id, *, from_date, to_date) -> dict[currency, list[{period_start, cash_minor, assets_minor, investments_minor, debts_minor}]]` — one point per month-end in the range (reuse the `period` month helpers / the snapshot backfill cadence), each = `net_worth_components_as_of(month_end)`. Endpoint `GET /api/v1/analytics/net-worth-composition?from&to` (require_workspace+require_initialized; router owns the last-12-months default; service clock-free).

- [ ] **Step 1: Failing tests:** `net_worth_components_as_of` on a fixture returns the four parts correctly (cash from accounts+dated tx; assets from latest valuation ≤ date; investments from holdings; debts signed from loan remaining), per currency, and **their sum equals `net_worth_as_of` for the same date** (assert exactly); soft-deleted tx / future-dated items excluded; the composition series returns a point per month with the right parts and excludes other workspaces.
- [ ] **Step 2–4:** implement (prefer refactoring `net_worth_as_of` to sum the components so they can't drift); parity/full suite green. **Step 5:** commit `feat: net-worth component breakdown + composition series endpoint`.

---

### Task 2: Frontend — stacked-area composition chart on Insights

**Files:** `web/src/features/analytics/useAnalytics.ts` (`useNetWorthComposition`), a new `web/src/features/analytics/NetWorthComposition.tsx` (chart), mount it on `web/src/features/analytics/InsightsScreen.tsx`; `web/src/lib/queries.ts`; tests.

**Interfaces:** `useNetWorthComposition(range)` (base-currency, driven by the shared `PeriodSelector` already on Insights). `NetWorthComposition` — a shadcn `ChartContainer` + Recharts stacked `AreaChart`: three positive stacked bands **cash → `--chart-1`, assets → `--chart-2`, investments → `--chart-3`** (stack up), and **debts → `--pc-negative`** as a negative band stacking below the zero axis (Recharts stacks negatives downward); a zero `ReferenceLine`; a `ChartTooltip` showing each part + the net total; a legend (Cash / Assets / Investments / Debts). `isAnimationActive={false}`; responsive; empty state. Place it on Insights (its own `GraphCard`), driven by the same period selector as the other Insights cards.

- [ ] **Step 1: Failing tests (vitest):** `NetWorthComposition` renders the stacked series from a mocked composition response (asserts the four series/legend + a tooltip value), uses the base currency, and shows an empty state when no data; the Insights period selector drives its range (query key includes the range).
- [ ] **Step 2–4:** `npm run build && lint && test` green (0 warnings). **Step 5:** commit `feat(web): net-worth composition stacked-area on Insights`.

---

## Self-review notes
- **Coverage:** component decomposition that provably sums to the existing total (T1); the stacked-area on Insights driven by the shared period selector (T2). Every net-worth ingredient (cash/assets/investments/debts) is surfaced.
- **Consistency:** reuses `net_worth_as_of`'s exact computations (refactored to sum components, so they can't drift from the headline net worth), the `period` month helpers, the shadcn `ChartContainer`, the vibrant `--chart-*` for positives + semantic coral for debts; never cross-currency; clock-free.
- **No migration:** components reconstructed on the fly (household scale, ~12 month points) — same approach as the net-worth series.
- **Deferred:** persisting components into snapshots (only needed if reconstruction gets slow — it won't at this scale).
