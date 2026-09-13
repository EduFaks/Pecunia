# Plan A (v1.1) — Transaction Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make categories first-class — a `Category` entity (kind income/expense, on-brand color, icon), an optional `category_id` on transactions, budgets moved from free-text `category` to `category_id`, sensible defaults seeded per workspace, and budget-vs-actual. This is the keystone the v1.1 graphs stand on.

**Architecture:** Follows the established finance pattern exactly (model + migration + service[flush-not-commit, events, workspace-scoped] + thin router + hooks/screen). One migration `0006`. Categories seed when a workspace is created (in `initialize_instance`) and for demo data.

**Tech Stack:** no new deps (lucide icons arrive in track F; here `icon` is just a stored string).

## Global Constraints

- Follow `docs/CONVENTIONS.md` (layering, transaction contract, §3 StrEnum+CHECK, §4 money minor units, §6 pagination, §7 events/allowlists, §8 testing). Spec: `docs/superpowers/specs/2026-09-11-pecunia-v1-design.md` (this is v1.1 track A per `docs/superpowers/plans/2026-09-12-00-v1.1-roadmap.md`).
- Workspace-scoped (D7) + `is_demo` on `categories`. Money integer minor units. Events published for audit/activity. Conventional commits, **no trailers**. Baseline at branch start: backend 264 pytest, web 515 vitest green.
- `color` is constrained to a fixed on-brand categorical palette (an allowlist), not arbitrary hex, so charts stay on-brand. `icon` is a short string key (a lucide name; validated loosely as `[a-z0-9-]+`).
- Budgets currently carry a free-text `category`; this plan **replaces it with `category_id`** (pre-1.0, demo-only data — no production migration burden). Budget-vs-actual = sum of expense transactions with that category in the budget's period.

---

### Task 1: Category model, migration 0006, default seeding, allowlist, cleanup

**Files:** Create `api/src/pecunia/models/category.py`; modify `api/src/pecunia/models/__init__.py`, `api/src/pecunia/models/transaction.py` (add `category_id`), `api/src/pecunia/models/budget.py` (replace `category` → `category_id`), `api/src/pecunia/services/setup.py` (seed defaults at workspace creation), `api/src/pecunia/services/demo.py` (seed demo categories + categorize demo tx), `api/src/pecunia/audit/allowlists.py`, `api/tests/conftest.py` (`_pg_clean`); create `api/alembic/versions/0006_categories.py`; test `api/tests/test_migration_0006.py`.

**Interfaces:**
- `Category`: `id` uuid PK, `workspace_id` FK→workspaces CASCADE NOT NULL (idx), `name` Text, `kind` Text CHECK (`income`|`expense`), `color` Text (from the palette allowlist), `icon` Text NULL, `archived_at` NULL, `is_demo` bool, timestamps. `CategoryKind` StrEnum. Unique `(workspace_id, name, kind)`.
- `Transaction.category_id`: `uuid | None` FK→categories (ON DELETE SET NULL — deleting a category leaves transactions uncategorized, never destroys them). Index `(category_id)`.
- `Budget.category_id`: `uuid | None` FK→categories (SET NULL); the old `category` text column is dropped.
- `pecunia.models.category.DEFAULT_CATEGORIES`: the seed set — e.g. income: Salary, Other Income; expense: Groceries, Dining, Transport, Housing, Utilities, Health, Entertainment, Shopping, Other — each with an on-brand `color` + a lucide `icon` name. A `PALETTE` allowlist of ~8 on-brand hexes.
- `seed_default_categories(db, workspace_id)` called from `initialize_instance` (and demo uses it/flags is_demo).

- [ ] **Step 1: Failing tests** — `api/tests/test_migration_0006.py`: categories table exists + kind CHECK rejects a bad kind + `(workspace_id,name,kind)` unique; `Transaction.category_id` and `Budget.category_id` FKs exist and old `budgets.category` column is gone; `test_schema_parity` (compare_metadata, copy the 0005 pattern) is clean; deleting a category SET NULLs its transactions (not cascade-delete).
- [ ] **Step 2:** verify fail (ImportError/undefined column). **Step 3:** implement the model (mirror `account.py`), the migration (create categories + indexes + FKs; `op.add_column` category_id on transactions/budgets; `op.drop_column budgets.category`), export in `__init__`, extend allowlist (`category` = {id,name,kind,color,icon,is_demo}; add `category_id` to the `transaction`/`budget` allowlists), `_pg_clean` (delete categories after transactions/budgets, before workspaces — mind the SET NULL). Add `seed_default_categories` and call it in `initialize_instance`.
- [ ] **Step 4:** green (parity + all). **Step 5:** commit `feat: category model, migration, and default seeding`.

---

### Task 2: CategoryService + endpoints + wire category_id into transactions & budgets

**Files:** Create `api/src/pecunia/services/categories.py`, `api/src/pecunia/api/categories.py`; modify `api/src/pecunia/services/transactions.py` + `api/src/pecunia/api/transactions.py` (accept/validate/return `category_id`, optional `?category_id=` list filter), `api/src/pecunia/services/budgets.py` + `api/src/pecunia/api/budgets.py` (`category_id` in/out), `api/src/pecunia/main.py` (mount); tests `api/tests/test_categories.py` (+ extend transaction/budget tests).

**Interfaces:**
- `CategoryService(db)`: create/list/get/update/archive (mirror `AccountService`; events `category.created/updated/archived`; add these to `Actions` + an `activity.category.created` template if wanted — keep audit-only is fine). Scoped via `scoped_select`/`get_scoped`.
- Endpoints `/api/v1/categories` (require_workspace, require_initialized): POST 201, GET (list, keyset by created_at), GET/{id}, PATCH/{id}, POST/{id}/archive. `CategoryOut` = {id,name,kind,color,icon,archived_at,is_demo}.
- Transactions: `TransactionIn`/`Update` accept optional `category_id`; the service validates it belongs to the workspace (404/422 if foreign); `TransactionOut` returns it; list accepts `?category_id=`. Budgets: analogous `category_id`.

- [ ] **Step 1: Failing tests:** create a category → 201 + listed; invalid kind/color → 422; a transaction created with a category_id from another workspace → 404/422; a transaction returns its category_id; listing `?category_id=` filters; archiving a category leaves its transactions (category_id still set or nulled per the SET-NULL choice — assert the chosen behavior); budget carries category_id.
- [ ] **Step 2–4:** implement mirroring accounts/transactions; keep parity + full suite green. **Step 5:** commit `feat: category service, endpoints, and transaction/budget wiring`.

---

### Task 3: Budget-vs-actual

**Files:** Modify `api/src/pecunia/services/budgets.py` (+ maybe a small `period.py` helper), `api/src/pecunia/api/budgets.py`; tests `api/tests/test_budget_actual.py`.

**Interfaces:** for a budget with a `category_id` + `period` (weekly/monthly/quarterly/yearly) + `amount_minor`, compute `actual_minor` = sum of the absolute value of **expense** transactions (amount_minor < 0) in that category within the **current period window** (compute the window from `period` relative to a reference date — pass `now`/today in, don't use a forbidden clock in tests). Expose `actual_minor` (and `remaining_minor = amount_minor - actual_minor`) on `BudgetOut` (list + detail). A budget with no `category_id` reports `actual_minor = null` (can't compute). Keep it one clean scoped query per budget (N+1 acceptable at household scale; note it for the v1.1-E batch pass).

- [ ] **Step 1: Failing tests:** a monthly budget with a category + three in-period expense transactions reports the summed actual + remaining; transactions outside the period window or in another category/workspace are excluded; a categoryless budget → actual null; period-window math correct for monthly/weekly (use a fixed reference date).
- [ ] **Step 2–4:** implement; full suite green. **Step 5:** commit `feat: budget vs actual spend`.

---

### Task 4: Frontend — category picker, management, budget-vs-actual, demo

**Files:** Create `web/src/features/categories/` (hooks, CategoriesScreen or a Settings→Categories panel, CategoryPicker, CategoryBadge); modify `web/src/features/transactions/TransactionForm.tsx` + `web/src/features/budgets/*` (adopt CategoryPicker + show category), `web/src/features/settings/*` (mount a Categories management section) and nav if a top-level screen; `web/src/lib/queries.ts` (`qk.categories`); tests.

**Interfaces:** `useCategories` (+ create/update/archive mutations invalidating `qk.categories`). `CategoryPicker` — a Select/combobox grouped by kind, showing each category's color swatch + icon + name (icon rendered as the stored string for now; track F swaps in lucide). `CategoryBadge` — a small colored chip (color + name) for lists. Adopt the picker in TransactionForm and BudgetForm; render the badge in the transactions list and account/transaction rows. Budgets screen shows a **budget-vs-actual** bar (actual/amount, using the bronze progress-fill exception already sanctioned in CONVENTIONS §9.1, clay when over budget) + remaining via MoneyText. A Categories management panel under Settings (list, create, edit color/name/icon, archive). Demo data should already be categorized (Task 1). Follow the DataList/kit/token patterns; keyset pagination; tokens only.

- [ ] **Step 1: Failing tests (vitest):** CategoryPicker lists categories grouped by kind and selects one; TransactionForm submits the chosen category_id; a transaction row shows its CategoryBadge; the Budgets screen renders the vs-actual bar (over-budget shows clay); the Categories panel creates/edits/archives.
- [ ] **Step 2–4:** implement; `npm run build && npm run lint && npm run test` green. **Step 5:** commit `feat(web): categories — picker, management, badges, budget-vs-actual`.

---

## Self-review notes
- **Coverage:** Category entity + kind/color/icon (T1), seeded defaults (T1), tx + budget wiring (T2), budget-vs-actual (T3), full UI incl. management + picker + badges + vs-actual bar (T4). SET NULL protects transactions/budgets from category deletion. Demo data categorized.
- **Consistency:** mirrors accounts/transactions/budgets in every layer; reuses DataList/MoneyText/EmptyState/the kit; keyset pagination; StrEnum+CHECK for kind; allowlist extended (no secret-like fields).
- **Deferred to E:** the spending-by-category donut + category-trend graphs (they consume this data; built in the graph suite). Batch the per-budget actual query then too.
