# Plan C (v1.1) — Project Funding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn V1's static Projects into the owner's **project-car model**: a project has a **type** (saving | spending) and a target (goal or expected budget); a **planned parts list** (existing `ProjectItem`, name + estimated amount); real **transactions link to a project** (`tx.project_id`) and can be **attached to a specific part** (`project_item.transaction_id` = "mark bought"); and progress is redefined as **planned (Σ parts) vs actual (Σ linked transactions) vs target**, per part and per project.

**Why the redefinition:** today `funded_total = Σ ProjectItem.amount_minor` — the plan *is* the funding, a placeholder. The roadmap says "funded = linked tx." Track C makes **actual = Σ transactions linked to the project** and keeps **planned = Σ parts** as a separate figure, so a spending project reads "planned $X, spent $Y of budget $Z" and a saving project reads "saved $Y of goal $Z." Existing project tests/UI that assume `funded = Σ items` are updated here (pre-1.0, demo-only data).

**Architecture:** Extends the existing Projects domain (`models/project.py`, `services/projects.py`, `api/projects.py`, `web/src/features/projects/*`) — no new top-level feature. One migration `0008`. Mirrors the category_id/payee_id wiring for the new `tx.project_id`. Money stays integer minor units; every table already workspace-scoped (D7).

**Tech Stack:** no new deps.

## Global Constraints
- Follow `docs/CONVENTIONS.md` (layering; transaction contract — services flush, routers commit; §3 StrEnum+CHECK; §4 money minor units; §6 keyset pagination; §7 events/allowlists; §8 testing/parity; §9 frontend tokens). Roadmap: Track C (depends on A; richer with the just-merged Payees).
- New enum `ProjectType {saving, spending}` (StrEnum + CHECK), column NOT NULL with `server_default='spending'`. `tx.project_id` FK→projects **SET NULL** (deleting a project never destroys transactions). `project_items.transaction_id` FK→transactions **SET NULL** (deleting a transaction un-marks the part, never destroys it).
- **Invariant:** if `project_item.transaction_id` is set, that transaction's `project_id` MUST equal the item's `project_id`. The attach operation sets both; enforce/validate in the service (a transaction can fulfill at most one part — `project_items.transaction_id` is unique where not null).
- Conventional commits, **no trailers**. Baseline at branch start: backend 363 pytest, web 565 vitest green.

---

### Task 1: Model + migration 0008 (project type, tx.project_id, item.transaction_id) + demo

**Files:** `api/src/pecunia/models/project.py` (add `type`; add `ProjectItem.transaction_id`), `api/src/pecunia/models/transaction.py` (add `project_id`), `api/src/pecunia/models/__init__.py` (unchanged unless needed), `api/src/pecunia/audit/allowlists.py` (extend `project` with `type`; `project_item` with `transaction_id`; `transaction` with `project_id`), `api/src/pecunia/services/demo.py`, `api/tests/conftest.py` (`_pg_clean` ordering), create `api/alembic/versions/0008_project_funding.py`, test `api/tests/test_migration_0008.py`.

**Interfaces:**
- `ProjectType(StrEnum)`: `SAVING="saving"`, `SPENDING="spending"`. `Project.type` Text NOT NULL, CHECK `type IN (...)`, server_default `'spending'`.
- `Transaction.project_id`: `uuid | None` FK→projects `ondelete=SET NULL`, indexed (mirror `category_id`).
- `ProjectItem.transaction_id`: `uuid | None` FK→transactions `ondelete=SET NULL`; a **unique** constraint on `transaction_id` (partial/where-not-null, or rely on app-level + a plain unique that tolerates multiple NULLs — Postgres treats NULLs as distinct in a UNIQUE, so a plain `UniqueConstraint("transaction_id")` already allows many NULLs and blocks a tx fulfilling two parts). Prefer the plain unique constraint.

- [ ] **Step 1: Failing tests** (`test_migration_0008.py`, mirror 0007): `projects.type` exists with CHECK (rejects a bad value) and defaults to `spending`; `transactions.project_id` FK→projects SET NULL (delete project → transaction survives, project_id NULL); `project_items.transaction_id` FK→transactions SET NULL (delete transaction → item survives, transaction_id NULL) + unique on transaction_id (a second item cannot take the same tx); `test_schema_parity` (compare_metadata) clean.
- [ ] **Step 2:** verify fail. **Step 3:** implement model fields + migration (`op.add_column` all three; the CHECK; the unique on `project_items.transaction_id`; indexes; FK-safe `downgrade()`), extend allowlists, fix `_pg_clean` ordering (delete `project_items` before `transactions` and before `projects`; delete `transactions` — mind tx.project_id → projects SET NULL means transactions can be deleted before projects; item.transaction_id → transactions SET NULL means items reference transactions — so delete order: project_items, then transactions, then projects; verify against existing order and both new SET NULLs). Demo: give each demo project a `type`; link a few demo transactions to a project (`project_id`); attach at least one transaction to a project part (`item.transaction_id` + matching `project_id`) so the "bought" path has demo coverage. Keep onboard→demo 201 + demo `counts` shape.
- [ ] **Step 4:** green (parity + all). **Step 5:** commit `feat: project type, transaction-project linkage, part fulfillment (migration 0008)`.

---

### Task 2: Service + endpoints — type, project_id wiring, part attach/detach, planned-vs-actual

**Files:** `api/src/pecunia/services/projects.py`, `api/src/pecunia/api/projects.py`, `api/src/pecunia/services/transactions.py` + `api/src/pecunia/api/transactions.py` (project_id in/out + `?project_id=` filter), tests `api/tests/test_projects.py` (extend) + `test_transactions.py`.

**Interfaces:**
- `ProjectService.create/update` accept `type` (default spending); validate against the enum.
- **Redefine funding** — replace `funded_total` (Σ items) with two figures, both workspace-scoped single queries:
  - `planned_minor(project)` = `Σ ProjectItem.amount_minor` (the old funded_total; keep the query, rename).
  - `actual_minor(project)` = `Σ ABS(Transaction.amount_minor)` for transactions with `project_id == project.id`. (Saving contributions and spending expenses both count by magnitude toward the target.)
  - Expose `planned_minor`, `actual_minor`, and `type` on `ProjectOut` (list + detail). The target-reached activity now fires when **actual** crosses `target_amount_minor` (on link/attach), not when an item is added — move that logic accordingly; `add_item` no longer emits funded/target activity (it emits a plain `project_item.created`).
- **Attach / detach a transaction to a part** — `attach_item_transaction(item, transaction)` and `detach_item_transaction(item)`:
  - validate the transaction belongs to the workspace (404 if foreign) and is not already attached to another part (409/422);
  - set `item.transaction_id = tx.id` AND `tx.project_id = item.project_id` (uphold the invariant); detach clears `item.transaction_id` (leave `tx.project_id` as-is unless the caller also unlinks — document the choice: detach clears only the part link, the transaction stays linked to the project);
  - emit `project_item.updated` (+ a `project.target_reached` activity if actual now crosses target).
- **Transactions:** `TransactionIn/Update` accept optional `project_id`; validate belongs-to-workspace (404 foreign); `TransactionOut` returns it; list `?project_id=` filter (mirror category_id/payee_id). Per-part "actual": a part's actual cost = its attached transaction's `ABS(amount_minor)` (null if unattached) — expose on the item-out shape.
- Endpoints: extend the projects router — `type` in project in/out; item-out gains `transaction_id` + `actual_minor`; add `POST /projects/{id}/items/{item_id}/attach` (body: transaction_id) and `POST .../detach`. Keep require_workspace/require_initialized.

- [ ] **Step 1: Failing tests:** create a saving vs spending project (type persisted, defaulted); `actual_minor` sums linked transactions by magnitude and excludes other workspaces/projects; `planned_minor` sums items; a transaction created/updated with a foreign `project_id` → 404; `?project_id=` filters; attaching a transaction to a part sets both `item.transaction_id` and `tx.project_id` and makes the part's actual = the tx magnitude; attaching an already-attached transaction to a second part → 409/422; detach clears the part link; deleting the attached transaction SET NULLs the item (migration test covers the DB, add a service-level assertion the item is un-bought); target-reached activity fires when actual crosses target via a link (not via add_item).
- [ ] **Step 2–4:** implement; parity + full suite green. **Step 5:** commit `feat: project funding — type, tx linkage, part fulfillment, planned-vs-actual`.

---

### Task 3: Frontend — type toggle, project picker on transactions, parts with attach/mark-bought, planned-vs-actual

**Files:** `web/src/features/projects/*` (`ProjectForm` add type toggle; `ProjectDetail` planned-vs-actual + parts attach/bought UI; `FundingBar`/`funding.ts` use actual vs target with type-aware labels; `projectTypes.ts`; `useProjects.ts` add attach/detach mutations + project_id types), `web/src/features/transactions/TransactionForm.tsx` (+ list rows) to pick/show a project, `web/src/lib/queries.ts` (invalidations), tests.

**Interfaces:**
- `ProjectForm`: a **Saving / Spending** segmented toggle (default Spending). Labels adapt: saving → "Goal"/"Saved"; spending → "Budget"/"Spent". `funding.ts` keeps the clamp/percent logic but is driven by `actual` vs `target`; add a small helper or prop for the type-aware label set (tokens only; the accent progress-fill is the sanctioned §9.1 exception — over-budget spending may switch to `--pc-negative` like BudgetVsActualBar; a saving goal reached stays accent + a positive Pill).
- `ProjectDetail`: show planned total, actual total, and target; the parts list renders each part as **planned $X → [Attach transaction]** or **bought $Y** (with the linked transaction) + a detach; attach opens a picker of the workspace's transactions (reuse a simple transaction picker/combobox; select-existing-only, mirror `PayeePicker`'s pattern). Marking bought = attaching; un-bought = detach.
- `TransactionForm`: a **Project** picker (optional, select-existing) that sets `project_id`; rows/detail show the linked project name. `useProjects` gains `useAttachItemTransaction`/`useDetachItemTransaction` mutations invalidating the project + its items + transactions.

- [ ] **Step 1: Failing tests (vitest):** `ProjectForm` submits the chosen type and shows type-aware labels; `FundingBar` renders actual/target and switches to over-budget styling past 100% for spending; `ProjectDetail` shows planned vs actual and lists a part as bought when it has an attached transaction; attaching a transaction to a part calls the attach mutation; `TransactionForm` submits `project_id`; a transaction row shows its project.
- [ ] **Step 2–4:** implement; `npm run build && npm run lint && npm run test` green. **Step 5:** commit `feat(web): project funding — type toggle, project linkage, part attach/mark-bought, planned-vs-actual`.

---

## Self-review notes
- **Coverage:** type (T1), tx↔project + part↔tx links with SET NULL + the fulfillment invariant/unique (T1), redefined planned-vs-actual + attach/detach + type in every layer (T2), full UI incl. type toggle, project picker on transactions, per-part attach/mark-bought, type-aware funding bar (T3). Demo exercises a linked transaction and a bought part.
- **Consistency:** `tx.project_id` mirrors category_id/payee_id exactly; attach/detach mirror the archive-style service methods; funding math stays pure/testable (`funding.ts`); StrEnum+CHECK for type; allowlist extended (no secret-like fields).
- **Behavior change called out:** funded (Σ items) → actual (Σ linked tx) + planned (Σ items); the target-reached activity moves from add_item to the link/attach path. Existing project tests/UI updated to the new semantics (pre-1.0).
- **Deferred to E:** project-spend-over-time and per-project graphs (consume this linkage; built in the graph suite).
