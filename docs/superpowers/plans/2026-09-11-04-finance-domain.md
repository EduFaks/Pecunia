# Plan 04 — Finance Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The core financial data model and API: accounts (with derived balances), transactions (with soft-delete/restore and balance effects), projects + items, assets + valuation history, budgets — all workspace-scoped (D7), all publishing domain events (audit + activity), all flagged `is_demo` so a demo dataset can be seeded and cleanly removed.

**Architecture:** Follows `docs/CONVENTIONS.md` exactly. Each aggregate is a model module + hand-written migration + a service (flush-not-commit, publishes events, workspace-scoped via a shared helper) + a thin router (owns commits, cursor-paginated list endpoints per the §2 read-only allowance). Money is integer **minor units** + a 3-letter ISO currency code — never floats.

**Tech Stack:** no new runtime dependencies.

## Global Constraints

- **Follow `docs/CONVENTIONS.md` for every decision.** Spec authority: `docs/superpowers/specs/2026-09-11-pecunia-v1-design.md` (§7 data-model delta, demo-data behavior, D7).
- **Money:** amounts are signed integer **minor units** in a `BigInteger` column (`*_minor`), paired with a `currency` `String(3)` (ISO-4217, uppercase). No `Float`/`Numeric` for amounts. The API accepts and returns integer minor units; formatting is the frontend's job.
- **Workspace scoping (D7):** every finance table has a non-null `workspace_id` FK (`ON DELETE CASCADE`). Every service method is scoped through `require_workspace`/`current_workspace_id` and filters by it — no unscoped tenant query. A helper enforces this; a CI-style test asserts a cross-workspace fetch returns nothing.
- **Soft delete + restore** for transactions (`deleted_at`); everything else uses `archived_at` where the spec calls for archive (accounts, projects). Deletes of assets/budgets are hard (with audit).
- **Events:** every mutation publishes a `DomainEvent` via `event_bus` inside the request transaction (audit row commits atomically). Value-movement events carry `activity_template` + `activity_params` so they surface in the activity feed; pure-CRUD noise (e.g. account renamed) is audited but may omit activity. Extend `pecunia/audit/allowlists.py` for each new resource; `test_no_secret_leak` must stay green.
- **`is_demo`** boolean (default false, not null) on accounts, transactions, projects, assets, budgets (and cascade-carried on project_items / asset_valuations via their parent). The demo remover deletes exactly the `is_demo = true` rows in one transaction; real rows are never touched.
- Enumerated values (account type, project status, asset type, budget period) get a DB `CHECK` **and** a Python `StrEnum` (CONVENTIONS §3).
- Cursor pagination: finance entities have **UUID** PKs, so listings must NOT order by `id` (random UUID order). They use **keyset pagination** on a time column with the id as tiebreaker via `pecunia.pagination.keyset_page(db, stmt, sort_col, id_col, *, cursor, limit)` — transactions order by `(occurred_on DESC, id DESC)`, everything else by `(created_at DESC, id DESC)`; opaque string cursor `"{sort_value}|{id}"`; `{items, next_cursor}`, limit default 50 cap 200. The monotonic-bigint log tables (audit/activity) keep `cursor_page` on `id`. (Both modes are documented in CONVENTIONS §6.)
- Python 3.12, `uv run` from `api/`, TDD per task, conventional commits, **no trailers**, full suite green before each commit. Baseline at branch start: 130 passed. Every DB test inherits `_pg_clean` — and `_pg_clean` must be extended to truncate/delete the new tables.

---

## File Structure (end state)

```
api/src/pecunia/
├── money.py                      NEW: currency validation + minor-unit helpers
├── pagination.py                 NEW: shared cursor_page() (refactor audit/activity onto it)
├── models/
│   ├── account.py  transaction.py  project.py  asset.py  budget.py   NEW
│   └── __init__.py               MOD: export new models
├── services/
│   ├── scoping.py                NEW: workspace-scoped repository helpers
│   ├── accounts.py transactions.py projects.py assets.py budgets.py  NEW
│   └── demo.py                   NEW: seed_demo_data / remove_demo_data
├── api/
│   ├── accounts.py transactions.py projects.py assets.py budgets.py  NEW
│   ├── demo.py                   NEW: POST /demo, DELETE /demo
│   ├── audit.py activity.py      MOD: use pagination.cursor_page
│   └── deps.py                   MOD: require_workspace (AuthContext + workspace_id)
├── audit/allowlists.py           MOD: account/transaction/project/asset/budget entries
├── activity/templates.py         NEW: activity template-key constants
└── alembic/versions/0005_finance_domain.py   NEW  (one migration for all finance tables)

api/tests/                        + test_money, test_pagination, test_scoping,
                                  test_accounts, test_transactions, test_projects,
                                  test_assets, test_budgets, test_demo, test_migration_0005
```

Rationale for one migration (0005) covering all finance tables: they form one cohesive schema addition with cross-FKs (transaction→account, project_item→project, asset_valuation→asset), and shipping them together keeps the revision graph legible. Services/routers stay one-file-per-aggregate.

---

### Task 1: Foundations — money, shared pagination, workspace scoping

**Files:**
- Create: `api/src/pecunia/money.py`, `api/src/pecunia/pagination.py`, `api/src/pecunia/services/scoping.py`, `api/src/pecunia/activity/__init__.py`, `api/src/pecunia/activity/templates.py`
- Modify: `api/src/pecunia/api/audit.py`, `api/src/pecunia/api/activity.py` (use `cursor_page`), `api/src/pecunia/api/deps.py` (`require_workspace`)
- Test: `api/tests/test_money.py`, `api/tests/test_pagination.py`, `api/tests/test_scoping.py`

**Interfaces:**
- Produces: `pecunia.money` — `CURRENCY_RE` (compiled `^[A-Z]{3}$`), `validate_currency(code) -> str` (raises `ValueError`), `CurrencyStr` (an `Annotated[str, ...]` Pydantic type enforcing the pattern). `pecunia.pagination.cursor_page(db, stmt, id_col, *, cursor, limit, default=50, cap=200) -> tuple[list, int | None]` (stmt must be ordered by `id_col.desc()`; applies `id_col < cursor` when cursor set, fetches `limit+1`, trims, computes next_cursor). `pecunia.services.scoping.ScopedRepo`-style helper OR simple functions `scoped_select(model, workspace_id)` returning `select(model).where(model.workspace_id == workspace_id)`, and `get_scoped(db, model, id, workspace_id)` returning the row or None. `pecunia.api.deps.require_workspace` → returns `(AuthContext, workspace_id)` or a small dataclass `WorkspaceContext(ctx, workspace_id)`. `pecunia.activity.templates.Activity` (template-key constants).

- [ ] **Step 1: Failing tests** — `api/tests/test_money.py`

```python
import pytest

from pecunia.money import validate_currency


def test_valid_currency():
    assert validate_currency("BRL") == "BRL"


def test_lowercase_rejected():
    with pytest.raises(ValueError):
        validate_currency("brl")


def test_wrong_length_rejected():
    with pytest.raises(ValueError):
        validate_currency("BR")
```

`api/tests/test_pagination.py`:

```python
import sqlalchemy as sa

from pecunia.models import AuditEvent
from pecunia.pagination import cursor_page


async def test_cursor_page_walks_without_skip_or_overlap(db):
    for i in range(5):
        db.add(AuditEvent(action=f"account.created", resource_id=str(i)))
    await db.flush()
    stmt = sa.select(AuditEvent).order_by(AuditEvent.id.desc())
    seen = []
    cursor = None
    for _ in range(10):
        items, cursor = await cursor_page(db, stmt, AuditEvent.id, cursor=cursor, limit=2)
        seen.extend(i.id for i in items)
        if cursor is None:
            break
    assert len(seen) == 5
    assert len(set(seen)) == 5  # no dupes
    assert seen == sorted(seen, reverse=True)  # newest-first


async def test_limit_capped(db):
    stmt = sa.select(AuditEvent).order_by(AuditEvent.id.desc())
    items, _ = await cursor_page(db, stmt, AuditEvent.id, cursor=None, limit=9999)
    # cap does not raise; just clamps — assert no error and list returned
    assert isinstance(items, list)
```

`api/tests/test_scoping.py`:

```python
import uuid

import sqlalchemy as sa

from pecunia.models import AuditEvent  # any workspace_id-bearing model works for the helper shape


async def test_scoped_select_filters_by_workspace(db):
    ws1, ws2 = uuid.uuid4(), uuid.uuid4()
    db.add(AuditEvent(action="account.created", workspace_id=ws1))
    db.add(AuditEvent(action="account.created", workspace_id=ws2))
    await db.flush()
    from pecunia.services.scoping import scoped_select
    rows = (await db.execute(scoped_select(AuditEvent, ws1))).scalars().all()
    assert all(r.workspace_id == ws1 for r in rows)
    assert len(rows) == 1
```

- [ ] **Step 2: Verify fail** (ModuleNotFoundError).

- [ ] **Step 3: Implement.** `api/src/pecunia/money.py`:

```python
import re
from typing import Annotated

from pydantic import AfterValidator

CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def validate_currency(code: str) -> str:
    if not CURRENCY_RE.match(code):
        raise ValueError("currency must be a 3-letter uppercase ISO-4217 code")
    return code


CurrencyStr = Annotated[str, AfterValidator(validate_currency)]
```

`api/src/pecunia/pagination.py`:

```python
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


async def cursor_page(
    db: AsyncSession,
    stmt: sa.Select,
    id_col: Any,
    *,
    cursor: int | None,
    limit: int,
    default: int = DEFAULT_LIMIT,
    cap: int = MAX_LIMIT,
) -> tuple[list, int | None]:
    """Newest-first cursor pagination. `stmt` must already be ordered by
    `id_col.desc()`. Returns (items, next_cursor); next_cursor is the last
    returned item's id when a full page was available, else None."""
    n = max(1, min(limit or default, cap))
    q = stmt
    if cursor is not None:
        q = q.where(id_col < cursor)
    q = q.limit(n + 1)
    rows = list((await db.execute(q)).scalars())
    if len(rows) > n:
        rows = rows[:n]
        return rows, rows[-1].id
    return rows, None
```

`api/src/pecunia/services/scoping.py`:

```python
import uuid
from typing import TypeVar

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

T = TypeVar("T")


def scoped_select(model: type[T], workspace_id: uuid.UUID) -> sa.Select:
    """A SELECT of `model` restricted to one workspace (D7). Every tenant read
    goes through this — never a bare select(model) on finance data."""
    return sa.select(model).where(model.workspace_id == workspace_id)


async def get_scoped(
    db: AsyncSession, model: type[T], id_: uuid.UUID, workspace_id: uuid.UUID
) -> T | None:
    row = await db.get(model, id_)
    if row is None or row.workspace_id != workspace_id:
        return None
    return row
```

`api/src/pecunia/activity/__init__.py` — empty. `api/src/pecunia/activity/templates.py`:

```python
class Activity:
    """Activity-feed template keys. The frontend renders these + params (i18n)."""

    ACCOUNT_CREATED = "activity.account.created"
    TRANSACTION_CREATED = "activity.transaction.created"
    PROJECT_CREATED = "activity.project.created"
    PROJECT_FUNDED = "activity.project.funded"
    PROJECT_TARGET_REACHED = "activity.project.target_reached"
    ASSET_CREATED = "activity.asset.created"
    ASSET_VALUATION_CHANGED = "activity.asset.valuation_changed"
    BUDGET_CREATED = "activity.budget.created"
```

`require_workspace` in `deps.py` (uses existing `current_workspace_id`):

```python
@dataclass
class WorkspaceContext:
    ctx: AuthContext
    workspace_id: uuid.UUID


async def require_workspace(
    ctx: Annotated[AuthContext, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> WorkspaceContext:
    ws = await current_workspace_id(ctx, db)
    return WorkspaceContext(ctx=ctx, workspace_id=ws)
```

Refactor `api/audit.py` and `api/activity.py` to call `cursor_page(db, stmt, Model.id, cursor=cursor, limit=limit)` instead of their inline limit+1 logic (behavior identical; their tests must stay green).

- [ ] **Step 4: Green** — new tests pass; audit/activity endpoint tests still green (refactor is behavior-preserving). Full suite.
- [ ] **Step 5: Commit** — `feat: money, currency validation, shared cursor pagination, workspace scoping`

---

### Task 2: Accounts

**Files:**
- Create: `api/src/pecunia/models/account.py`, `api/src/pecunia/services/accounts.py`, `api/src/pecunia/api/accounts.py`
- Modify: `api/src/pecunia/models/__init__.py`, `api/src/pecunia/audit/allowlists.py`, `api/src/pecunia/main.py` (mount), `api/tests/conftest.py` (`_pg_clean` + a `workspace_ctx`/auth helper for tests)
- Migration is deferred to Task 7's single `0005` — BUT to test Task 2 now, add the accounts table to a growing `0005` migration in THIS task and extend it in later tasks (each finance task appends its table to `0005` until Task 7 finalizes it). The parity test guards correctness at each step.

> **Decision:** build `0005_finance_domain.py` incrementally — Task 2 creates it with the `accounts` table; Tasks 3–6 each add their tables to the same revision (it hasn't shipped, so editing in place is correct per CONVENTIONS §5). Every task keeps `test_migration_0005::test_schema_parity` green.

**Interfaces:**
- Produces: `Account` model (`id` uuid PK, `workspace_id` uuid FK NOT NULL CASCADE, `name` text, `type` text CHECK, `currency` String(3), `initial_balance_minor` BigInteger default 0, `archived_at` timestamptz NULL, `is_demo` bool default false, `created_at`/`updated_at`); `AccountType` StrEnum (`checking`,`savings`,`credit_card`,`cash`,`brokerage`,`wallet`). `pecunia.services.accounts.AccountService(db)` with `create/list/get/update/archive` and `balance(account) -> int` (initial + sum of non-deleted transactions — until transactions exist in Task 3, balance == initial_balance_minor). Endpoints under `/api/v1/accounts` (require_workspace): `POST` (201), `GET` (list, cursor), `GET /{id}` (with balance), `PATCH /{id}`, `POST /{id}/archive` (204). Events: `account.created` (+ `activity.account.created`), `account.updated`, `account.archived`.

- [ ] **Step 1: Failing tests** — `api/tests/test_accounts.py` (representative; implementer adds coverage for validation + scoping)

```python
LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 100000}


async def _auth(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_create_account(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/accounts", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Checking"
    assert body["balance_minor"] == 100000  # no transactions yet


async def test_list_and_get(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    lst = (await client.get("/api/v1/accounts", headers=h)).json()
    assert any(a["id"] == created["id"] for a in lst["items"])
    got = await client.get(f"/api/v1/accounts/{created['id']}", headers=h)
    assert got.status_code == 200


async def test_invalid_type_and_currency_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    assert (await client.post("/api/v1/accounts", json=NEW | {"type": "mattress"}, headers=h)).status_code == 422
    assert (await client.post("/api/v1/accounts", json=NEW | {"currency": "brl"}, headers=h)).status_code == 422


async def test_archive(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    acc = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    assert (await client.post(f"/api/v1/accounts/{acc['id']}/archive", headers=h)).status_code == 204
    # archived accounts excluded from the default list
    lst = (await client.get("/api/v1/accounts", headers=h)).json()
    assert all(a["id"] != acc["id"] for a in lst["items"])


async def test_account_created_is_audited_and_in_activity(client, initialized_instance, db):
    import sqlalchemy as sa
    from pecunia.models import AuditEvent, ActivityEntry
    h = await _auth(client, initialized_instance)
    await client.post("/api/v1/accounts", json=NEW, headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "account.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.account.created" in templates
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.** `api/src/pecunia/models/account.py`:

```python
import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, String, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, DateTime, Text, Uuid

from pecunia.models.base import Base


class AccountType(StrEnum):
    CHECKING = "checking"
    SAVINGS = "savings"
    CREDIT_CARD = "credit_card"
    CASH = "cash"
    BROKERAGE = "brokerage"
    WALLET = "wallet"


_TYPES = "','".join(t.value for t in AccountType)


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint(f"type IN ('{_TYPES}')", name="type_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    initial_balance_minor: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=text("0"))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
```

`api/src/pecunia/services/accounts.py` — `AccountService` with create (adds row, publishes `account.created` with `activity_template=Activity.ACCOUNT_CREATED`, `activity_params={"name":..., "type":...}`, `after=project("account", account)`), list (scoped_select, exclude archived unless `include_archived`), get_scoped, update (publishes account.updated with before/after), archive (sets archived_at, publishes account.archived). `balance(account)` returns `initial_balance_minor` for now (Task 3 extends to add the transaction sum). All flush-not-commit.

`api/src/pecunia/api/accounts.py` — router `prefix="/accounts"`, `dependencies=[Depends(require_initialized)]`; schemas `AccountIn` (name, type: `AccountType`, currency: `CurrencyStr`, initial_balance_minor: int = 0), `AccountUpdate` (optional fields), `AccountOut` (+ `balance_minor`). Endpoints call the service with `wsctx.workspace_id`, then `await db.commit()`. List uses `cursor_page`.

Extend `allowlists.py`: `"account": frozenset({"id","name","type","currency","initial_balance_minor","is_demo"})`.

Add to `_pg_clean`: delete `accounts` (before workspaces, since FK). Add a conftest helper `auth_headers(client)` if convenient (optional).

- [ ] **Step 4: Green + full suite. Step 5: Commit** — `feat: accounts — model, service, endpoints, balance, events`

---

### Task 3: Transactions

**Files:**
- Create: `api/src/pecunia/models/transaction.py`, `api/src/pecunia/services/transactions.py`, `api/src/pecunia/api/transactions.py`
- Modify: `models/__init__.py`, `services/accounts.py` (balance now sums transactions), `alembic/versions/0005_finance_domain.py` (add `transactions` table), `allowlists.py`, `main.py`, `conftest.py` (`_pg_clean`)
- Test: `api/tests/test_transactions.py`

**Interfaces:**
- Produces: `Transaction` model (`id` uuid PK, `workspace_id` FK NOT NULL CASCADE, `account_id` FK→accounts CASCADE NOT NULL, `amount_minor` BigInteger NOT NULL (signed: positive=inflow, negative=outflow), `currency` String(3), `description` text, `payee` text NULL, `occurred_on` Date NOT NULL, `deleted_at` timestamptz NULL, `is_demo` bool, timestamps). `TransactionService(db)`: `create` (validates account belongs to workspace + currency matches account, publishes `transaction.created` + `activity.transaction.created`), `list` (scoped, by account optional, excludes soft-deleted, cursor), `get`, `update` (before/after audit), `soft_delete` (sets deleted_at, publishes transaction.deleted), `restore` (clears deleted_at, publishes transaction.restored). `AccountService.balance` now = `initial_balance_minor + sum(amount_minor of non-deleted transactions)`. Endpoints `/api/v1/transactions`: POST, GET (list, `?account_id=&cursor=&limit=`), GET/{id}, PATCH/{id}, DELETE/{id} (soft, 204), POST /{id}/restore (204).

- [ ] **Step 1: Failing tests** — `api/tests/test_transactions.py` (representative)

```python
import datetime as dt

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {"Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"}


async def _account(client, h):
    return (await client.post("/api/v1/accounts",
            json={"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 100000},
            headers=h)).json()


async def test_create_transaction_affects_balance(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = {"account_id": acc["id"], "amount_minor": -8499, "currency": "BRL",
          "description": "Apple Store", "occurred_on": "2026-09-11"}
    resp = await client.post("/api/v1/transactions", json=tx, headers=h)
    assert resp.status_code == 201
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["balance_minor"] == 100000 - 8499


async def test_soft_delete_and_restore_roundtrip_balance(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions",
          json={"account_id": acc["id"], "amount_minor": -5000, "currency": "BRL",
                "description": "x", "occurred_on": "2026-09-11"}, headers=h)).json()
    await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)
    assert (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()["balance_minor"] == 100000
    await client.post(f"/api/v1/transactions/{tx['id']}/restore", headers=h)
    assert (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()["balance_minor"] == 95000


async def test_deleted_excluded_from_list(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions",
          json={"account_id": acc["id"], "amount_minor": -5000, "currency": "BRL",
                "description": "x", "occurred_on": "2026-09-11"}, headers=h)).json()
    await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)
    lst = (await client.get(f"/api/v1/transactions?account_id={acc['id']}", headers=h)).json()
    assert all(t["id"] != tx["id"] for t in lst["items"])


async def test_currency_mismatch_rejected(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post("/api/v1/transactions",
        json={"account_id": acc["id"], "amount_minor": -1, "currency": "USD",
              "description": "x", "occurred_on": "2026-09-11"}, headers=h)
    assert resp.status_code == 422


async def test_cannot_touch_other_workspace_account(client, initialized_instance):
    h = await _auth(client)
    import uuid
    resp = await client.post("/api/v1/transactions",
        json={"account_id": str(uuid.uuid4()), "amount_minor": -1, "currency": "BRL",
              "description": "x", "occurred_on": "2026-09-11"}, headers=h)
    assert resp.status_code == 404
```

- [ ] **Step 2–5:** implement model + migration table + service (balance sum via `func.coalesce(func.sum(...),0)` over non-deleted transactions) + router; extend allowlist (`"transaction": {"id","account_id","amount_minor","currency","description","payee","occurred_on","is_demo"}`) and `_pg_clean` (delete transactions before accounts). Currency-mismatch and cross-workspace account → 422/404 respectively. Commit `feat: transactions — soft delete/restore, balance effects, events`.

---

_(Tasks 4–7 continue in the same shape; see below.)_

### Task 4: Projects + project items

**Files:** Create `models/project.py`, `services/projects.py`, `api/projects.py`; modify `models/__init__.py`, `0005` migration (add `projects`, `project_items`), `allowlists.py`, `main.py`, `conftest.py`; Test `api/tests/test_projects.py`.

**Interfaces:**
- `Project` (`id`, `workspace_id` FK NOT NULL CASCADE, `name`, `description` text NULL, `target_amount_minor` BigInteger NULL, `currency` String(3), `status` text CHECK, `archived_at` NULL, `is_demo`, timestamps); `ProjectStatus` StrEnum (`active`,`completed`,`archived`). `ProjectItem` (`id`, `workspace_id` FK NOT NULL CASCADE, `project_id` FK→projects CASCADE NOT NULL, `name`, `amount_minor` BigInteger NOT NULL, `is_demo`, timestamps).
- `ProjectService`: `create` (publishes `project.created` + `activity.project.created`), `list`/`get` (scoped), `update`, `delete` (hard, `project.deleted`), `add_item`/`update_item` (publish `project_item.created`/`project_item.updated`; after adding an item, compute funded total = sum(items.amount_minor); if it crosses `target_amount_minor` for the first time publish `activity.project.target_reached`, else `activity.project.funded` with `{project, funded, target, currency}`), `funded_total(project) -> int`.
- Endpoints `/api/v1/projects`: POST, GET(list,cursor), GET/{id} (with `funded_minor`), PATCH/{id}, DELETE/{id} (204); nested items: POST `/projects/{id}/items`, PATCH `/projects/{id}/items/{item_id}`, GET `/projects/{id}/items`.
- Representative tests: create project; add items and assert `funded_minor` sums; adding an item that reaches target emits `activity.project.target_reached`; project scoped (other-workspace project → 404); `project.created` audited + `activity.project.created` present.
- allowlist: `"project": {"id","name","status","currency","target_amount_minor","is_demo"}`, `"project_item": {"id","project_id","name","amount_minor","is_demo"}`. `_pg_clean`: delete project_items, then projects. Commit `feat: projects and project items with funding progress and events`.

### Task 5: Assets + valuations

**Files:** Create `models/asset.py`, `services/assets.py`, `api/assets.py`; modify `models/__init__.py`, `0005` (add `assets`, `asset_valuations`), `allowlists.py`, `main.py`, `conftest.py`; Test `api/tests/test_assets.py`.

**Interfaces:**
- `Asset` (`id`, `workspace_id` FK NOT NULL CASCADE, `name`, `type` text CHECK, `currency` String(3), `acquired_on` Date NULL, `is_demo`, timestamps); `AssetType` StrEnum (`vehicle`,`property`,`investment`,`watch`,`other`). `AssetValuation` (`id`, `workspace_id` FK NOT NULL CASCADE, `asset_id` FK→assets CASCADE NOT NULL, `value_minor` BigInteger NOT NULL, `as_of` Date NOT NULL, `source` text NULL, `is_demo`, `created_at`).
- `AssetService`: `create` (`asset.created` + `activity.asset.created`), `list`/`get` (scoped; `current_value_minor` = latest valuation by `as_of` desc, else None), `update`, `delete` (hard, `asset.deleted`), `add_valuation` (`asset.valuation.created`; if there was a prior valuation, publish `activity.asset.valuation_changed` with `{asset, from, to, currency}`), `update_valuation` (`asset.valuation.updated`). Endpoints `/api/v1/assets`: POST, GET(list,cursor), GET/{id} (with `current_value_minor`), PATCH/{id}, DELETE/{id}; valuations: POST `/assets/{id}/valuations`, GET `/assets/{id}/valuations` (history, cursor), PATCH `/assets/{id}/valuations/{vid}`.
- Representative tests: create asset; add two valuations, assert `current_value_minor` is the latest by `as_of` and that the second emits `activity.asset.valuation_changed` with correct from/to; scoped (other-workspace asset → 404). allowlist: `"asset": {"id","name","type","currency","is_demo"}`, `"asset_valuation": {"id","asset_id","value_minor","as_of","source","is_demo"}`. `_pg_clean`: delete asset_valuations, then assets. Commit `feat: assets and valuation history with change events`.

### Task 6: Budgets

**Files:** Create `models/budget.py`, `services/budgets.py`, `api/budgets.py`; modify `models/__init__.py`, `0005` (add `budgets`), `allowlists.py`, `main.py`, `conftest.py`; Test `api/tests/test_budgets.py`.

**Interfaces:**
- `Budget` (`id`, `workspace_id` FK NOT NULL CASCADE, `name`, `category` text NULL, `period` text CHECK, `amount_minor` BigInteger NOT NULL, `currency` String(3), `is_demo`, timestamps); `BudgetPeriod` StrEnum (`weekly`,`monthly`,`quarterly`,`yearly`).
- `BudgetService`: `create` (`budget.created` + `activity.budget.created`), `list`/`get` (scoped), `update` (`budget.updated`), `delete` (hard, `budget.deleted`). Endpoints `/api/v1/budgets`: POST, GET(list,cursor), GET/{id}, PATCH/{id}, DELETE/{id}.
- Representative tests: CRUD; invalid period 422; scoped; created audited. allowlist: `"budget": {"id","name","category","period","amount_minor","currency","is_demo"}`. `_pg_clean`: delete budgets. Commit `feat: budgets — model, service, endpoints, events`.

### Task 7: Demo data — seed & clean removal; finalize migration 0005

**Files:** Create `api/src/pecunia/services/demo.py`, `api/src/pecunia/api/demo.py`; modify `main.py` (mount), `conftest.py`; Test `api/tests/test_demo.py`, `api/tests/test_migration_0005.py`. Finalize/verify the `0005_finance_domain.py` migration now that all tables are present (add a `test_schema_parity` in `test_migration_0005.py`).

**Interfaces:**
- `pecunia.services.demo.seed_demo_data(db, workspace_id, *, base_currency) -> dict` — creates a realistic dataset ALL flagged `is_demo=true`, in the workspace's base currency: e.g. 3 accounts (checking/savings/credit_card), ~20 transactions across the last two months, 1 project with items (one reaching target), 1 asset (vehicle) with 2–3 valuations showing a decline, 1 budget. Publishes `data.demo_seeded`. Returns counts. `remove_demo_data(db, workspace_id) -> dict` — deletes exactly `is_demo=true` rows for that workspace across all finance tables (children first: asset_valuations, project_items, transactions, then assets, projects, accounts, budgets); publishes `data.demo_removed`; returns counts. Real (`is_demo=false`) rows untouched.
- Endpoints (require_workspace): `POST /api/v1/demo` (201, seeds using the instance base_currency from `instance_state.settings`) — refuse with 409 `DEMO_ALREADY_PRESENT` if demo rows already exist for the workspace; `DELETE /api/v1/demo` (204, removes). `GET /api/v1/demo` → `{present: bool, counts: {...}}` so the UI chip can show/remove.
- Representative tests: seed → accounts/transactions/project/asset/budget all exist and are `is_demo=true`, in base currency; a real account created before seeding is NOT is_demo; remove → all demo rows gone, the real account remains; `data.demo_seeded`/`data.demo_removed` audited; seed twice → 409; activity feed shows demo activity entries then (optionally) they remain or are cleared — decide: demo removal also deletes the activity_entries it created (filter by resource_id? simpler: demo activity entries are acceptable to leave, but cleaner to delete activity/audit? Audit is append-only — do NOT delete audit rows. Activity entries: delete those whose resource_id points at removed demo resources is complex; simplest correct V1: leave activity/audit history intact (they're historical facts), only delete the domain rows. Document this.).
- `test_migration_0005.py`: `test_schema_parity` (compare_metadata clean) + a spot check that all finance tables exist. Commit `feat: demo data seed and clean removal`.

**Demo removal scope decision (document in report + CONVENTIONS §7 note):** `remove_demo_data` deletes only the demo *domain rows* (accounts…budgets). It does NOT delete audit rows (append-only) nor activity entries (historical record). The spec's "demo data can be cleanly removed" refers to the financial data that would otherwise pollute balances/lists — satisfied. The `GET /demo` `present` flag is computed from the domain tables.

---

## Self-review notes

- **Spec coverage:** §7 data-model delta — accounts/transactions/projects+items/assets+valuations/budgets all present with `workspace_id` + `is_demo` (Tasks 2–6); demo seed/remove (Task 7); events with activity templates feed the activity timeline (all tasks); allowlists extended and `test_no_secret_leak` stays green. Money as integer minor units throughout (§4/CONVENTIONS §4).
- **Type consistency:** `*_minor: int` (BigInteger) + `currency: CurrencyStr` everywhere; `balance_minor`/`funded_minor`/`current_value_minor` are computed ints; every service scoped through `scoped_select`/`get_scoped`; cursor pagination via the single `cursor_page` helper; StrEnums (`AccountType`/`ProjectStatus`/`AssetType`/`BudgetPeriod`) each paired with a DB CHECK.
- **Migration:** one incrementally-built `0005` finalized in Task 7; parity test guards it at every task.
- **Carryover addressed:** the shared cursor-pagination helper (Plan 03 ride-along) is extracted in Task 1 and adopted by audit/activity + all finance listings.
- **Deferred:** multi-currency conversion/net-worth rollup across currencies (V1 stores per-entity currency; cross-currency aggregation is a later concern), transaction CSV/OFX import (spec mentions `transaction.imported`/`data.imported` — endpoints reserved, not built in V1), category taxonomy (free-text `category` on budgets/transactions for now), and **attachments/file storage** (spec §7 lists an `attachments` table and the architecture diagram shows a file-storage volume for receipts/asset photos/documents — this is a self-contained later concern, not part of the finance data model; deliberately out of Plan 04 scope).
