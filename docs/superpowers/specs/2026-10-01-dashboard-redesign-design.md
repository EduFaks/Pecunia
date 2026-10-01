# Pecunia v1.6 — Daily Dashboard Redesign + Mobile PWA Shell (Design)

**Status:** approved 2026-10-01. Continues the series after v1.5 (Track T bank sync) → **v1.6 = Track U**.

## Goal

Turn the dashboard homepage into a glance-first daily view for a phone-installed PWA, anchored on one question — *"how much can I still spend this month?"* — now that accounts and cards sync automatically. Give the whole app a native-app feel on iPhone (bottom tab bar, safe-area, pull-to-refresh) and a restyle toward a minimalist, high-end, high-tech dark aesthetic.

## Global constraints

All work follows `docs/CONVENTIONS.md`:
- **§4 money**: integer minor units, never float, **never summed across currencies** — every analytics figure stays a per-currency map. The dashboard renders the workspace **base currency** (from `instance_state.settings.base_currency`, default BRL) as the primary view; other currencies, if present, appear compactly, never summed in.
- Services **flush**, routers **commit**; services **clock-free** (`today: date` passed in from the router).
- New analytics is workspace-scoped, read-only, reuses existing aggregations (`cashflow`, `committed_monthly`, forecast occurrence expansion) rather than re-deriving them.
- Frontend: Tailwind v4 `--pc-*` tokens only (no raw hex), Recharts via the existing `components/ui/chart.tsx` wrappers, TanStack Query with the `qk` factory, Vitest + Testing Library, co-located tests. Money/dates via `MoneyText`/`DateText`; hero figures use `variant="hero"` (tabular-nums).
- Mobile: 16px inputs, `min-w-0`, `overflow-x-auto` for wide content, `flex-wrap` clusters; respect `env(safe-area-inset-*)`.
- **Conventional commits, NO trailers.**

## Locked decisions (from brainstorming)

1. **Anchor metric = safe-to-spend** ("quanto ainda posso gastar este mês"), the hero of the screen.
2. Ceiling basis = **expected month income − fixed costs**, AND an optional **monthly budget cap** as a second guardrail; the displayed figure is the **min** of the two.
3. Scheduled/recurring **income** (planned receipts) counts toward expected income.
4. Daily-use cards below the anchor: **Resultado do mês**, **Gastei em quê**, **A vencer / a receber**, **Contas e cartões**.
5. App shell gets a **bottom tab bar + safe-area + pull-to-refresh** (mobile), keeping the desktop sidebar.
6. The current richer widgets (net-worth-over-time, goals, savings-rate KPI, recent activity) **move to Insights**; the dashboard stays lean.
7. Restyle: **minimalist, high-end, high-tech, dark** ("batman") — push the existing dark minimal-tech skin, not a new palette.

---

## Track U — the work

### U1. Safe-to-spend metric (backend)

**New:** `SafeToSpendService` (or a method on `AnalyticsService`), clock-free, per currency, for the current month:

```
safe_to_spend = expected_income − committed_remaining − spent_mtd
```
- `expected_income` = income received month-to-date (`cashflow` income_minor, current month) + scheduled/recurring **income** occurrences due in `(today, month_end]` (reuse `forecast`'s `expand_occurrences`).
- `committed_remaining` = Σ subscriptions renewing in `(today, month_end]` + Σ loan planned payments due in `(today, month_end]` + Σ recurring **planned expenses** due in `(today, month_end]`. (Only what's still to leave — anything already paid is inside `spent_mtd`, so no double count.)
- `spent_mtd` = total expense month-to-date (`cashflow` spend_minor, current month; abs).

**Budget guardrail:** a new optional `monthly_budget_minor` per currency stored in `instance_state.settings` (nullable). When set, `budget_remaining = monthly_budget_minor − spent_mtd`, and the **displayed** safe-to-spend = `min(safe_to_spend, budget_remaining)`; a flag `limited_by: "income" | "budget"` tells the UI which bound won.

**Derived extras** returned for the UI: `days_remaining` (today → month_end inclusive), `daily_allowance = max(0, displayed_safe) / days_remaining`, and the breakdown pieces (`expected_income`, `committed_remaining`, `spent_mtd`, `monthly_budget_minor`).

**Endpoint:** `GET /api/v1/analytics/safe-to-spend` → `dict[str, SafeToSpendOut]` (per currency); router passes `today = date.today()`. `SafeToSpendOut`: `safe_minor`, `displayed_safe_minor`, `limited_by`, `expected_income_minor`, `committed_remaining_minor`, `spent_mtd_minor`, `monthly_budget_minor` (nullable), `days_remaining`, `daily_allowance_minor`.

**Settings write:** extend the existing preferences/settings update path to accept an optional `monthly_budget_minor` (per base currency in v1 — a single value keyed by base currency; multi-currency budgets deferred). Audited via the existing `"settings"` allowlist (add the field).

**Tests:** formula from a fixture workspace (income MTD + scheduled income; committed-remaining excludes already-due; no double count with spent_mtd); budget cap binding vs not (`limited_by`); days_remaining/daily_allowance incl. last-day-of-month edge (days_remaining ≥ 1, no divide-by-zero); per-currency isolation; endpoint shape + clock injection.

### U2. Dashboard screen (frontend)

Rewrite `web/src/features/dashboard/Dashboard.tsx` as a lean vertical stack of cards (base currency), each its own component under `features/dashboard/`:

1. **`SafeToSpendCard`** (hero): month label + `days_remaining`; the displayed safe figure in `variant="hero"`; a progress bar of `spent_mtd` against the ceiling; `daily_allowance` ("~R$ X/dia"); a one-line breakdown (renda · fixos a vir · gasto); a subtle `limited_by: "budget"` note when the budget binds. Hook `useSafeToSpend()` → `/analytics/safe-to-spend`.
2. **`MonthResultCard`**: entrou / saiu month-to-date + projected end-of-month surplus/deficit (green/red). Reuses `useSummary()` (savings = income/spend MTD) and `useForecast()` (projected month-end cash point) — no new endpoint.
3. **`SpendingBreakdownCard`**: "Gastei em quê" — reuse `CategoryChart` donut from `useSpendingByCategory()`, plus month total and ↑/↓ vs previous month (from `cashflow`/`summary`).
4. **`UpcomingCard`**: next ~14 days of due/receivable from `useUpcoming()` (already exists), compact rows (date · label · signed amount).
5. **`AccountsCardsCard`**: per-account balances + credit cards showing used/limit bar and bill due date, from `useBankConnections()` (bank-sync links) joined with `/accounts`. Non-synced accounts still listed with balance only.

Keep the `"dashboard"` query-key suffix convention for bounded reads. Loading/error/empty states per card (reuse `GraphCard`'s `ChartEmpty`/`ChartError` and `EmptyState`). Extract the inline `CashflowChart` into `features/analytics/` if reused; otherwise drop it from the dashboard (it moves to Insights).

**Moved to Insights** (`InsightsScreen.tsx` already hosts the richer analytics): net-worth-over-time + forecast tail, net-worth composition, goals detail, savings-rate/committed/net-worth-change KPI trio, recent activity. Ensure nothing the dashboard drops is *only* reachable from the dashboard — add to Insights where missing (goals widget, activity feed).

### U3. Mobile app shell (frontend)

In `web/src/components/layout/AppShell.tsx`:
- **Bottom `TabBar`** (new component) shown below `md`, hidden at `md:+` (desktop keeps the sidebar). Tabs: Dashboard (`/`), Transações (`/transactions`), Insights (`/insights`), Contas (`/accounts`), Settings (`/settings`) — `lucide-react` icons + labels, active state via `NavLink`, `aria-current`.
- **Safe-area**: tab bar padded with `env(safe-area-inset-bottom)`; main content gets matching bottom padding so nothing hides behind the bar; honor `safe-area-inset-top/left/right` where relevant. Add `viewport-fit=cover` to the `index.html` viewport meta.
- **Pull-to-refresh** on the dashboard scroll container: a lightweight touch handler that, on an over-scroll pull past a threshold, invalidates the dashboard query keys (`qk.analytics` + the dashboard-suffixed account/bank keys) and shows a spinner. Scoped to the dashboard in v1.
- Keep the existing hamburger drawer available at the top for the full nav list (tabs are the top 5; everything else stays in the drawer/sidebar).

### U4. Restyle (frontend, token-level)

Push the existing dark minimal-tech skin toward high-end/high-tech, **at the token and shared-component level** so it lands app-wide, not just the dashboard:
- Near-black canvas (keep `#0a0a0b`), surfaces as subtly elevated greys with hairline borders; increase negative space and typographic hierarchy; reduce label noise.
- Hero/figures: large tabular-nums, high contrast; a restrained single accent (`--pc-accent`) for emphasis only; semantic emerald/coral strictly for value movement.
- Cards: `rounded-pc-lg`, thin borders, a very subtle elevation/glow on the hero card only; consistent spacing scale; micro-interactions with the existing `ease-pc`.
- Done by tuning `tokens.css`/`global.css` values and the shared `Card`/`Surface`/`SummaryHeader` components; avoid per-component hex. Verify light theme still reads (tokens have light/dark) — or, if the app is dark-only, confirm and keep.

## Testing strategy

TDD per unit. Backend: pytest + testcontainers, no network (safe-to-spend from fixtures). Frontend: Vitest + Testing Library, `apiFetch` mocked, Recharts stubbed as today; each new card tested for figure/empty/error; TabBar active-state + safe-area class presence; pull-to-refresh invalidation via a mocked query client. `npm run build && lint && test` and `pytest` green, 0 new warnings, before each merge.

## Out of scope / deferred

Multi-currency monthly budgets (v1 = single budget in base currency); offline service worker / background sync; push notifications for bills due; per-category budget rollup into the safe-to-spend ceiling (v1 uses one monthly number); transaction↔commitment linkage for exact fixed-vs-variable split (the `(today, month_end]` due-window approximation is the chosen model); reworking Insights beyond receiving the moved widgets.
