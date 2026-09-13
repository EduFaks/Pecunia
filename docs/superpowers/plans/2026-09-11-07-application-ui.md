# Plan 07 — Application UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The full authenticated application: a Dashboard showpiece, Accounts/Transactions, Assets/Valuations, Projects, Budgets, the Activity timeline, and Settings → Security (Sessions + Audit Log) + Preferences — plus the demo-data header chip. Every screen wires the Plan 02–04 API into Pecunia's dark-first identity, "premium enough to keep open on a second monitor."

**Architecture:** A `web/src/features/<domain>/` per area, each with TanStack Query hooks (thin wrappers over `apiFetch`) + screen components + forms, mounted under the existing `AppShell`. Shared: a `DataList`/table primitive, a `MoneyText`/`DateText` pair reading the instance preferences (from `/auth/me`), inline-SVG chart components (token-driven, no chart lib), empty states, and the demo chip. Everything follows CONVENTIONS §9.

**Tech Stack:** no new runtime deps (charts are hand-built inline SVG). Vitest + Testing Library; Playwright for the final visual pass.

## Global Constraints

- **Follow `docs/CONVENTIONS.md` §9** (tokens only, bronze = interactive/stroke/focus only, sage/clay = value movement only, Fraunces headings / Inter UI / mono figures with `tabular-nums`, keyset pagination via the existing helpers, in-memory token). Backend contracts fixed by Plans 02–04 (`/api/v1/...`, cursor/keyset `{items,next_cursor}`, `{detail}` errors, money as integer minor units + currency).
- **Money display:** always via a shared `MoneyText` using `formatMoney(minor, currency, locale)`; never raw division. Value movement (deltas, negative balances, P&L) uses `--pc-positive`/`--pc-negative`; everything else is ink. Do NOT color a plain balance green just because it's money.
- **Charts (dataviz principles):** inline SVG, driven by tokens — 1.5px strokes, ≤8%-alpha area fills, a faint hairline grid, an emphasized endpoint dot, `tabular-nums` axis labels, accessible (`role="img"` + `aria-label` summarizing the trend), responsive (viewBox + `preserveAspectRatio`), reduced-motion-safe. Semantic sage/clay only where the series represents gain/loss; otherwise the bronze accent or ink. One shared `<TimeSeriesChart>` / `<Sparkline>`.
- **Preferences:** the display locale/date/number formats come from the instance settings (fetched once via `/auth/me` → `preferences`); expose them through a `usePreferences()` hook and thread into `MoneyText`/`DateText`.
- **Accessibility & responsiveness:** keyboard-operable tables/forms/menus, visible focus rings, labeled controls; responsive from 360px (the shell collapses the sidebar on narrow viewports). Wide tables scroll inside their own container, never the page.
- Verification per task: `npm run build && npm run lint && npm run test` green. TDD for hooks/logic/forms; render/interaction tests for screens. Task 6 captures Playwright screenshots the controller reviews.
- Node 20 via nvm, npm, conventional commits **no trailers**, one task per commit.

---

## File Structure (end state)

```
web/src/
├── lib/preferences.tsx        usePreferences() (from /auth/me), MoneyText, DateText
├── components/
│   ├── data/DataList.tsx      list/table primitive + LoadMore (keyset cursor)
│   ├── data/EmptyState.tsx    branded empty states
│   ├── charts/TimeSeriesChart.tsx  Sparkline.tsx   (inline SVG, token-driven)
│   └── layout/DemoChip.tsx    header demo-data present/remove control
├── features/
│   ├── dashboard/             Dashboard screen + summary tiles + net-worth chart
│   ├── accounts/              hooks, AccountsScreen, AccountDetail, AccountForm
│   ├── transactions/          hooks, TransactionsScreen, TransactionForm (create/edit/delete/restore)
│   ├── assets/                hooks, AssetsScreen, AssetDetail (valuation history + chart), forms
│   ├── projects/              hooks, ProjectsScreen, ProjectDetail (items + funding), forms
│   ├── budgets/               hooks, BudgetsScreen, BudgetForm
│   ├── activity/              hooks, ActivityScreen (day-grouped human feed)
│   └── settings/              SettingsScreen, security/Sessions, security/AuditLog, PreferencesPanel
└── routes wired into AppShell (Plan 05) nav
```

---

### Task 1: App data layer, shared list/table, MoneyText/DateText, demo chip, nav wiring

**Files:** `lib/preferences.tsx`, `components/data/DataList.tsx`, `components/data/EmptyState.tsx`, `components/layout/DemoChip.tsx`, a `lib/queries.ts` (query-key factory) + per-domain hook stubs where cheap; wire `AppShell` nav links to routes + mount route placeholders for each screen; tests.

**Interfaces:** `usePreferences()` → `{base_currency, locale, date_format, number_format, timezone, first_day_of_week}` (from the cached `/auth/me`). `MoneyText({minor, currency, className, colorBySign?})` — renders `formatMoney`, mono tabular; `colorBySign` opt-in applies sage/clay. `DateText({iso})`. `DataList` — a generic keyset-paginated list: props `{queryKey, fetchPage(cursor)→{items,next_cursor}, renderRow, columns?, empty}` with a "Load more" that advances the cursor; keyboard-navigable. `EmptyState({icon?, title, body, action?})`. `DemoChip` — queries `GET /demo`; if present shows "Demo data · Remove" (DELETE /demo → invalidates all finance queries + a toast); if absent renders nothing (seeding happens in the wizard/settings). Query-key factory for cache consistency (`qk.accounts`, `qk.transactions(accountId)`, …).

- [ ] **Step 1: Failing tests:** `MoneyText` renders formatted money and applies sage/clay only when `colorBySign` + sign; `usePreferences` returns the cached preferences; `DataList` renders rows and "Load more" fetches the next cursor page and appends (no dupes); `DemoChip` shows Remove when `/demo` present and hides when absent, and DELETE invalidates + toasts.
- [ ] **Step 2–5:** implement, verify build/lint/test, commit `feat(web): app data layer, list primitive, money/date display, demo chip`.

---

### Task 2: Dashboard (the showpiece)

**Files:** `features/dashboard/*`, `components/charts/TimeSeriesChart.tsx` + `Sparkline.tsx`; tests.

**Interfaces:** the Dashboard at `/` — summary tiles (total balance per currency = sum of account balances grouped by currency; a net-worth figure combining accounts + latest asset valuations, per currency; counts), an **Accounts snapshot** (each account with its balance + a small Sparkline of recent activity if cheap, else just balances), a **Recent activity** panel (the latest activity feed entries rendered from template keys), and a **net-worth / balances TimeSeriesChart** (inline SVG, token-driven per the dataviz constraint — since there's no historical net-worth endpoint in V1, chart the available series: e.g. cumulative balance from transaction history for the primary account/currency, or asset valuation history; if no meaningful series exists yet, show a tasteful empty state rather than a fake chart). Data assembled from `/accounts` (+ balances), `/assets` (+ current values), `/activity`. Empty states guide a fresh (skipped-setup) instance toward adding accounts. The layout must feel premium: generous spacing, Fraunces section headings, mono figures, restrained surfaces — the "second monitor" bar.

- [ ] **Step 1: Failing tests:** dashboard renders balance-per-currency tiles from mocked accounts; net-worth combines account balances + latest asset valuations correctly (per currency, integer minor units); recent-activity panel renders template-keyed entries; `TimeSeriesChart` renders an SVG with the right point count + an accessible `aria-label`, and shows the empty state when given no data; sage/clay used only for deltas.
- [ ] **Step 2–5:** implement, verify, commit `feat(web): dashboard with balance summary, activity, and net-worth chart`. **The controller screenshots this in Task 6.**

---

### Task 3: Accounts + Transactions

**Files:** `features/accounts/*`, `features/transactions/*`; tests.

**Interfaces:** Accounts screen (`/accounts`): list (name, type, balance via MoneyText, archived toggle), create (AccountForm: name/type/currency/initial_balance), edit (PATCH), archive; empty state. Account detail (`/accounts/:id`): header (balance, type), a keyset-paginated transactions list for that account (DataList over `/transactions?account_id=`), and inline transaction create. Transactions screen (`/transactions`): all-accounts keyset list with an account filter; TransactionForm (create/edit: account, amount_minor via a currency-aware amount input, description, payee, occurred_on date, sign via inflow/outflow toggle); delete (soft) with a restore affordance (an "undo"/restore action on recently deleted, or a deleted filter). Balances update reactively (invalidate account queries after a mutation). Currency-mismatch (422) surfaces a friendly field error.

- [ ] **Step 1: Failing tests:** create account posts the right body + appears in the list; account detail lists that account's transactions + balance; creating a transaction updates the account balance (invalidation); soft-delete removes it from the list + restore brings it back; amount input maps a typed value to correct integer minor units for the account's currency; currency mismatch shows a field error.
- [ ] **Step 2–5:** implement, verify, commit `feat(web): accounts and transactions screens with reactive balances`.

---

### Task 4: Assets + Projects + Budgets

**Files:** `features/assets/*`, `features/projects/*`, `features/budgets/*`; tests.

**Interfaces:**
- **Assets** (`/assets`): list (name, type, current value via MoneyText); asset detail (`/assets/:id`): current value, a **valuation-history TimeSeriesChart** (inline SVG; a decline shows clay, a rise sage — value movement), the valuation history list, and "Add valuation" (value + as_of + source) which updates the chart + current value and (on a real move) surfaces in activity. Create/edit/delete asset.
- **Projects** (`/projects`): list (name, status, a funding progress bar = funded/target with the bronze accent); project detail (`/projects/:id`): items list + add item, funding progress, target-reached state; create/edit/delete.
- **Budgets** (`/budgets`): list + CRUD (name, category, period, amount via MoneyText).
All keyset-paginated, workspace-scoped by the backend, empty states, reactive invalidation.

- [ ] **Step 1: Failing tests:** asset detail renders the valuation chart from history (correct points; clay for a declining series) + adding a valuation updates current value; project funding bar computes funded/target and shows target-reached; budget CRUD round-trips; each list empty-states cleanly.
- [ ] **Step 2–5:** implement, verify, commit `feat(web): assets, projects, and budgets screens`.

---

### Task 5: Activity timeline + Settings (Security: Sessions + Audit Log; Preferences)

**Files:** `features/activity/*`, `features/settings/*`; tests.

**Interfaces:**
- **Activity** (`/activity`): the human feed — day-grouped (Today / Yesterday / date), each entry rendered from its `template_key` + `params` via a small renderer mapping keys to friendly sentences (e.g. `activity.asset.valuation_changed` → "‹asset› valuation changed · ‹from› → ‹to›" with MoneyText, clay/sage on the direction; `activity.project.target_reached` → "‹project› reached its target"; `activity.transaction.created` → "‹description› · ‹amount›"; `activity.account.created`, `activity.project.funded`, `activity.budget.created`, `activity.asset.created`). Keyset-paginated ("Load more").
- **Settings** (`/settings`) with sections. **Security → Sessions**: `GET /auth/sessions` list (device_label, client, last_active via DateText, "Current session" marker on the current family), per-session **Revoke** (`DELETE /auth/sessions/{id}` → refetch), and **Log out everywhere** (`POST /auth/logout-all` → the current session dies too → app routes to /login). Location text (if any) is display-only. **Security → Audit Log**: owner-only (`GET /audit-events`), day-grouped, filters (action, resource type, date range), cursor pagination, each row expandable to show before→after / metadata; matches the spec's example layout. **Preferences panel**: view the instance preferences (from `/auth/me`); (editing settings is a backend endpoint not built in V1 — show them read-only with a note, OR wire a settings PATCH only if it exists; it does NOT in V1, so read-only + "editable in a future update").

- [ ] **Step 1: Failing tests:** activity renders day groups + maps each template key to its sentence (valuation_changed shows from→to with the right direction color); Sessions lists sessions with a current marker, revoke calls DELETE + refetches, log-out-everywhere calls logout-all; Audit Log lists events with filters applied to the query + expandable detail + Load more; a non-owner is refused the audit log (403 → friendly message).
- [ ] **Step 2–5:** implement, verify, commit `feat(web): activity timeline and settings security (sessions, audit log)`.

---

### Task 6: App e2e + visual capture

**Files:** `web/e2e/app.spec.ts`; extend the Playwright config.

**Interfaces:** a Playwright test that, against a running stack initialized WITH demo data (the controller seeds via the wizard's demo option or `POST /demo`), logs in and visits Dashboard, Accounts, an Account detail, Transactions, an Asset detail (valuation chart), Projects, Activity, and Settings → Security (Sessions + Audit Log), asserting each renders real demo data, and **captures a full-page screenshot of each** to `web/e2e/screenshots/app-*.png`.

**Runbook (implementer documents; controller executes + reviews screenshots):** `docker compose down -v && docker compose up -d --build`; initialize via the API (owner + prefs) then `POST /demo` with the owner token (or drive the wizard); `npm run e2e`; review screenshots; `docker compose down -v`.

- [ ] **Step 1:** add the app e2e spec; unit suite stays green. **Step 2:** attempt the capture (implementer; report screenshot paths, or BLOCKED-on-browser). **Step 3:** commit `test(web): application end-to-end flow and screenshot capture`. Report screenshot paths for the controller's design review.

---

## Self-review notes

- **Spec coverage:** the Audit-Log UI + Sessions UI (spec §"Audit Log UI" / auth sessions example), the Activity-vs-Audit split rendered as a human feed, the demo-data chip (removable), sophisticated dark financial charts (dataviz-principled inline SVG), the "second monitor" dashboard. All money as integer minor units via MoneyText; green/red reserved for value movement (not decoration) per D5.
- **Consistency:** every domain feature follows one shape (query hooks → screen → form), reuses `DataList`/`MoneyText`/`EmptyState`/the chart components and the component kit; keyset pagination via the shared helper's cursors.
- **Deferred:** editing instance preferences (no backend endpoint in V1 — read-only), CSV/OFX import UI, attachments/receipts UI (file storage deferred, Plan 04 note), cross-currency net-worth consolidation (shown per-currency), TOTP/passkey/session-2FA UI.
- **Verification:** unit-tested logic + Task 6 Playwright screenshots the controller reviews for the identity (the dashboard especially).
