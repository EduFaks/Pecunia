# Track I (v1.2) — Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A dedicated **Subscriptions** screen — a registry of the recurring services you pay for, each with a **name, logo, cost, billing cycle, and next renewal**, plus optional links (the billing **contact**/vendor, the **account** it hits, a **category**). It rolls up your **monthly + annualized** subscription spend and lists **upcoming renewals**. It's a *tracker*, not an auto-poster (Planned already posts recurring transactions) — a "renew" action just advances the next-renewal date.

**Architecture:** New domain mirroring the finance pattern. A `Subscription` entity; a `SubscriptionService` with pure cost-normalization (`period`-based per-month/per-year factors) and a renewal-advance (reuse `period.advance`). Reuses Track H's **`ImageUpload`/`Avatar`** for the logo (a capped base64 data-URI column, validated + excluded from audit, same as contact avatar). One migration `0015`. Feeds the later **Upcoming widget** (Track M) with renewal dates.

## Global Constraints
- Follow `docs/CONVENTIONS.md` (layering; services flush/routers commit; §3 StrEnum+CHECK; §4 money integer minor units, never cross-currency; §6 keyset; §7 events/allowlists; §8 parity; §9 tokens; clock-free). Workspace-scoped (D7) + `is_demo`. Conventional commits, **no trailers**. Baseline at branch start: backend 591 pytest, web 760 vitest.
- `logo` is a capped base64 data-URI (`^data:image/(png|jpeg|webp);base64,`, ≤64KB → 422 `LOGO_INVALID`), **excluded from the audit allowlist** (bulky, non-sensitive) — same rules as contact `avatar`.

---

### Task 1: Subscription model + migration 0015 + demo

**Files:** create `api/src/pecunia/models/subscription.py`; modify `models/__init__.py`, `audit/allowlists.py`, `services/demo.py`, `api/tests/conftest.py`; create `api/alembic/versions/0015_subscriptions.py`; test `api/tests/test_migration_0015.py`.

**Interfaces:**
- `SubscriptionStatus(StrEnum)`: `ACTIVE="active"`, `CANCELED="canceled"`.
- `BillingFrequency` — reuse the existing `weekly|monthly|quarterly|yearly` vocabulary (a StrEnum or the same CHECK values as scheduled/loans).
- `Subscription`: `id` uuid PK; `workspace_id` FK→workspaces CASCADE NOT NULL idx; `name` Text NOT NULL; `logo` Text NULL (base64 data-URI); `amount_minor` BigInteger NOT NULL (>0); `currency` String(3) NOT NULL; `billing_frequency` Text NOT NULL CHECK; `next_renewal` Date NOT NULL; `started_on` Date NULL; `status` Text NOT NULL CHECK(active|canceled) `server_default 'active'`; `contact_id` FK→contacts SET NULL NULL; `account_id` FK→accounts SET NULL NULL; `category_id` FK→categories SET NULL NULL; `is_demo` bool; timestamps.

- [ ] **Step 1: Failing tests** (`test_migration_0015.py`, mirror 0013): table + the status & billing_frequency CHECKs + status default `active`; FKs (workspace CASCADE; contact/account/category SET NULL — deleting one nulls the link, subscription survives); `test_schema_parity` clean.
- [ ] **Step 2:** verify fail. **Step 3:** implement model + migration (create table, indexes, FKs, the two CHECKs; FK-safe downgrade), export, allowlist (`subscription` = {id,name,amount_minor,currency,billing_frequency,next_renewal,started_on,status,contact_id,account_id,category_id,is_demo} — **NO `logo`**), `_pg_clean` (subscriptions before contacts/accounts/categories/workspaces). Demo: seed 3–4 subscriptions (e.g. Netflix/Spotify→link the Netflix contact + Entertainment category, a gym, a cloud tool) with monthly/yearly cycles, next_renewal near the anchor, status active; logos null. Keep onboard→demo 201 + counts shape.
- [ ] **Step 4:** green (parity + all). **Step 5:** commit `feat: subscription model, migration 0015, demo`.

---

### Task 2: SubscriptionService + endpoints (CRUD, cost rollup, renew)

**Files:** create `api/src/pecunia/services/subscriptions.py`, `api/src/pecunia/api/subscriptions.py`; modify `main.py`, `audit/actions.py` + `activity/templates.py`; reuse `pecunia/period.py`; tests `api/tests/test_subscriptions.py`.

**Interfaces:**
- `SubscriptionService(db)` (flush, never commit): CRUD (create/list keyset by `next_renewal` asc/get/update/delete); validate `amount_minor > 0` (422), `logo` (prefix+size → 422 `LOGO_INVALID`), and that `contact_id`/`account_id`/`category_id` (when given) belong to the workspace (404). `set_status(sub, status)`; `renew(sub)` → advance `next_renewal = period.advance(next_renewal, billing_frequency)` (no transaction created — it's a tracker; document this). Pure helpers `monthly_minor(sub)` and `annual_minor(sub)` normalizing by frequency (weekly ×52/12, monthly ×1, quarterly ÷3→ per-month = amount/3, yearly ÷12 → per-month = amount/12; annual = monthly×12) — integer minor units, round consistently (define the rounding; e.g. round to nearest minor unit).
- `totals(workspace_id, *, status="active") -> per currency: {monthly_minor, annual_minor, count}` = Σ over active subs of the normalized figures (per currency; never cross-currency).
- Endpoints `/api/v1/subscriptions` (require_workspace, require_initialized): POST 201, GET list, GET/{id}, PATCH/{id}, POST/{id}/renew, DELETE/{id}; `GET /api/v1/subscriptions/totals`. `SubscriptionOut` = the fields + `logo` + computed `monthly_minor`/`annual_minor`.

- [ ] **Step 1: Failing tests:** CRUD (201/list soonest-renewal-first/get/update/delete; foreign contact/account/category → 404; amount≤0 → 422; invalid/oversized logo → 422); `monthly_minor`/`annual_minor` correct per frequency (e.g. a $120/yr sub → monthly 1000 minor, annual 12000; a $10/mo → monthly 1000, annual 12000; a weekly and quarterly case); `totals` sums active per currency and excludes canceled + never crosses currencies; `renew` advances `next_renewal` by one cycle and creates NO transaction; workspace-scoped.
- [ ] **Step 2–4:** implement; parity + full suite green. **Step 5:** commit `feat: subscription service, endpoints, cost rollup, renew`.

---

### Task 3: Frontend — Subscriptions screen (logos, totals, renewals)

**Files:** create `web/src/features/subscriptions/` (`useSubscriptions` + mutations, `SubscriptionsScreen`, `SubscriptionForm`); modify `web/src/components/layout/AppShell.tsx` (nav "Subscriptions") + router (`/subscriptions`), `web/src/lib/queries.ts`; tests.

**Interfaces:** `useSubscriptions` (list, active-first by next_renewal) + `useSubscriptionTotals` + mutations (create/update/delete/renew/set-status) invalidating `qk.subscriptions` (+ `["analytics"]` if a later widget reads it — at least `qk.subscriptions`). `SubscriptionsScreen` (route `/subscriptions`, nav "Subscriptions"): a header with the **total monthly + annualized** spend (base currency, from `totals`); a list of subscriptions each showing the **logo** (reuse `Avatar` with the subscription name+logo — a company-style fallback monogram), name, the normalized monthly cost + billing cycle, **next renewal** date, linked contact/category badges, status; row actions **Renew** (advances the date), edit, cancel/reactivate, delete (ConfirmDialog). `SubscriptionForm`: name + **logo** (`ImageUpload`) + amount (money input) + currency + billing frequency (Select) + next_renewal date + started_on + optional **contact** (`ContactPicker`) + account + category pickers + status. Sort by next renewal; canceled shown muted or filtered. Tokens only; keyset.

- [ ] **Step 1: Failing tests (vitest):** `SubscriptionsScreen` shows the monthly/annual totals and lists subscriptions with logo/next-renewal/cost; **Renew** calls the renew mutation; `SubscriptionForm` submits a new subscription (name/amount/frequency/next_renewal, + logo via ImageUpload, + optional contact); a canceled subscription reads as canceled; nav "Subscriptions" routes; empty state.
- [ ] **Step 2–4:** `npm run build && lint && test` green (0 warnings). **Step 5:** commit `feat(web): subscriptions — logos, monthly/annual totals, renewals`.

---

## Self-review notes
- **Coverage:** subscription entity + optional links (T1); CRUD + pure monthly/annual normalization + totals + renew (T2); the screen with logos, totals, renewals, and the form reusing `ImageUpload`/`ContactPicker` (T3).
- **Consistency:** reuses `period` (advance + frequency vocab), `ImageUpload`/`Avatar` (logo, same capped base64 + audit-excluded rule as contact avatar), the pickers, money integer minor units never cross-currency; StrEnum+CHECK for status/frequency; keyset by next_renewal.
- **Not an auto-poster:** subscriptions track cost + renewal; Planned remains the thing that posts recurring transactions. `renew` only advances the date. (A future link could tie a subscription to a Planned schedule.)
- **Feeds Track M:** the Upcoming widget will surface subscription `next_renewal` alongside planned + loan due dates.
