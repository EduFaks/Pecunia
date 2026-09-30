# Track T (v1.5) — Bank Sync via Open Finance / Pluggy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync bank-account balances, transactions, and credit-card activity from the owner's real banks into Pecunia via the Pluggy API (Meu Pluggy), with explicit per-account linking, `external_id` dedupe, an editable category mapping, a daily in-process job, and a Connections settings panel.

**Architecture:** A `BankProvider` abstraction (real `PluggyProvider` over httpx, `FakeBankProvider` in tests) feeds a `BankSyncService` that links Pluggy accounts to Pecunia accounts, imports POSTED transactions idempotently through `TransactionService.create(..., external_id=...)`, anchors balances once at link time, and records the bank-reported balance for a divergence alert. A guarded daily asyncio task mirrors the Track Q price sync. Spec: `docs/superpowers/specs/2026-09-30-bank-sync-pluggy-design.md`.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, httpx, pytest+testcontainers; Vite/React/TS, TanStack Query, Vitest.

## Global Constraints

- `docs/CONVENTIONS.md`: money = integer minor units (`Decimal(str(x))`, never binary-float math), never cross-currency; services **flush**, routers **commit**; business dates (`today`) passed in; workspace-scoped; StrEnum+CHECK; naming convention drives constraint names (`compare_metadata` parity). Conventional commits, **NO trailers**.
- **Branch `feat/plan-t-bank-sync` off `main`.** Baseline first: `cd api && uv run pytest -q` and `cd web && npm run test` — record counts; stay green, **0 new warnings**.
- **No real network in tests** — `PluggyProvider` is tested against `httpx.MockTransport`; everything else uses `FakeBankProvider`. `conftest.py` forces `PECUNIA_ENABLE_BANK_SYNC=false` (Task 6).
- **Migration revision = `0005`, `down_revision="0004"`.** New tables join `api/tests/conftest.py::_pg_clean` AND `api/src/pecunia/services/demo.py::_TABLES` (children before parents) in the same task as the migration.
- Pluggy API facts (spec §"Pluggy API facts"): `POST /auth` `{clientId, clientSecret}` → `{"apiKey"}` (~2h, header `X-API-KEY`); `GET /v2/items` and `GET /v2/transactions?accountId=&from=` return `{results, next}` where `next` carries the next page's `after` cursor (as a URL, query string, or bare token — parse robustly); `GET /accounts?itemId=` returns `{results: [...]}` unpaginated. Base URL `https://api.pluggy.ai`.

---

### Task 1: Migration 0005 + bank-sync models + `Transaction.external_id`

**Files:**
- Create: `api/src/pecunia/models/bank_sync.py`, `api/alembic/versions/0005_bank_sync.py`
- Modify: `api/src/pecunia/models/transaction.py`, `api/src/pecunia/models/__init__.py` (export the three new models), `api/tests/conftest.py::_pg_clean`, `api/src/pecunia/services/demo.py::_TABLES`
- Test: `api/tests/test_migration_0005.py`

**Interfaces — Produces:**

```python
class BankConnectionStatus(StrEnum):
    OK = "ok"
    ERROR = "error"

class BankConnection(Base):
    __tablename__ = "bank_connections"
    # id/workspace_id(ix, CASCADE)/is_demo/created_at/updated_at — standard columns as in Account
    pluggy_item_id: Mapped[str]            # Text, non-null
    institution_name: Mapped[str]          # Text, non-null
    status: Mapped[str]                    # Text, non-null, server_default 'ok', CHECK name="status_valid" → ck_bank_connections_status_valid
    last_error: Mapped[str | None]         # Text
    last_synced_at: Mapped[datetime | None]  # DateTime(timezone=True)
    # UniqueConstraint("workspace_id", "pluggy_item_id", name="uq_bank_connections_workspace_id_pluggy_item_id")

class BankAccountLink(Base):
    __tablename__ = "bank_account_links"
    # standard columns; plus:
    connection_id: Mapped[uuid.UUID]       # FK bank_connections.id ondelete CASCADE, index
    account_id: Mapped[uuid.UUID]          # FK accounts.id ondelete CASCADE, index
    pluggy_account_id: Mapped[str]         # Text, non-null
    sync_from: Mapped[date]                # Date, non-null
    provider_balance_minor: Mapped[int | None]      # BigInteger
    provider_balance_as_of: Mapped[datetime | None]
    credit_limit_minor: Mapped[int | None]          # BigInteger
    bill_close_date: Mapped[date | None]
    bill_due_date: Mapped[date | None]
    # UniqueConstraint("account_id", name="uq_bank_account_links_account_id")
    # UniqueConstraint("workspace_id", "pluggy_account_id", name="uq_bank_account_links_workspace_id_pluggy_account_id")

class BankCategoryMapping(Base):
    __tablename__ = "bank_category_mappings"
    # standard columns; plus:
    pluggy_category: Mapped[str]           # Text, non-null
    category_id: Mapped[uuid.UUID]         # FK categories.id ondelete CASCADE, non-null, index
    # UniqueConstraint("workspace_id", "pluggy_category", name="uq_bank_category_mappings_workspace_id_pluggy_category")
```

`Transaction` gains `external_id: Mapped[str | None]` (Text) and, in `__table_args__`, the partial unique index (same explicit name in model and migration so `compare_metadata` stays clean):

```python
Index(
    "uq_transactions_account_id_external_id",
    "account_id", "external_id",
    unique=True,
    postgresql_where=text("external_id IS NOT NULL"),
)
```

Migration `0005_bank_sync.py` (`revision="0005"`, `down_revision="0004"`): hand-written like `0004_goals.py`, docstring stating the design rationale (explicit link-or-create, dedupe key, tombstone semantics), `op.f(...)` names everywhere, real `downgrade()` (drop index/tables in reverse order).

Housekeeping (this task, not later): `_pg_clean` gains `"bank_category_mappings", "bank_account_links", "bank_connections"` inserted **before** `"transactions"` (mappings before `categories`, links before `accounts` and before `connections` — children before parents), with an order comment matching the file's style; `demo._TABLES` gains `(BankCategoryMapping, "bank_category_mappings"), (BankAccountLink, "bank_account_links"), (BankConnection, "bank_connections")` at the top (leaf children, counted-not-seeded, same comment style).

- [ ] **Step 1:** Failing tests in `test_migration_0005.py` (mirror `test_migration_0004.py`): after `upgrade head` the three tables exist and round-trip via ORM; `status='syncing'` violates the CHECK; duplicate `(workspace_id, pluggy_item_id)` / `(account_id)` / `(workspace_id, pluggy_account_id)` / `(workspace_id, pluggy_category)` raise IntegrityError; two transactions with NULL `external_id` on one account coexist but a duplicate non-null `(account_id, external_id)` is rejected; `downgrade` → `upgrade head` cycles cleanly (via `asyncio.to_thread(command.downgrade, ...)`); schema parity (`test_migration_0001.py::test_schema_parity`) still green.
- [ ] **Step 2–4:** models + migration + housekeeping lists; run `uv run pytest tests/test_migration_0005.py tests/test_migration_0001.py -q` then the full suite → green.
- [ ] **Step 5:** Commit `feat: bank-sync tables + transactions.external_id (migration 0005)`.

---

### Task 2: `BankProvider` protocol + `PluggyProvider` + `FakeBankProvider`

**Files:**
- Create: `api/src/pecunia/services/banksync/__init__.py` (empty), `api/src/pecunia/services/banksync/provider.py`
- Test: `api/tests/test_bank_provider.py`

**Interfaces — Produces:**

```python
PLUGGY_BASE_URL = "https://api.pluggy.ai"

class BankProviderError(Exception):
    """Any Pluggy failure — HTTP status (incl. 429), timeout, auth, bad JSON.
    Callers never see httpx."""

@dataclass(frozen=True)
class ProviderConnection:
    item_id: str
    institution_name: str   # item["connector"]["name"] (fallback "" if absent)
    status: str             # raw Pluggy item status, e.g. "UPDATED", "LOGIN_ERROR"

@dataclass(frozen=True)
class ProviderAccount:
    pluggy_account_id: str
    item_id: str
    type: str               # "BANK" | "CREDIT"
    subtype: str            # e.g. "CHECKING_ACCOUNT", "SAVINGS_ACCOUNT", "CREDIT_CARD"
    name: str
    number: str | None
    balance_minor: int      # bank: available funds; card: open amount OWED → stored NEGATIVE (see below)
    currency: str           # currencyCode
    credit_limit_minor: int | None   # creditData.creditLimit
    bill_close_date: date | None     # creditData.balanceCloseDate
    bill_due_date: date | None       # creditData.balanceDueDate

@dataclass(frozen=True)
class ProviderTransaction:
    external_id: str
    date: date              # from the ISO datetime "date" field
    description: str
    amount_minor: int       # SIGNED, Pecunia convention (see normalization)
    currency: str
    status: str             # "POSTED" | "PENDING" — passed through, the service filters
    pluggy_category: str | None

class BankProvider(Protocol):
    async def fetch_connections(self) -> list[ProviderConnection]: ...
    async def fetch_accounts(self, item_id: str) -> list[ProviderAccount]: ...
    async def fetch_transactions(self, pluggy_account_id: str, *, from_date: date) -> list[ProviderTransaction]: ...
```

`PluggyProvider(client_id: str, client_secret: str, *, client: httpx.AsyncClient | None = None, timeout: float = 10.0)`:
- `_api_key: str | None` cached in memory. `_auth()` → `POST /auth` json `{"clientId", "clientSecret"}` → `json()["apiKey"]`.
- `_get(path, params) -> object`: ensure api key; GET with header `{"X-API-KEY": key}`; if `response.status_code == 401` (checked **before** `raise_for_status`): drop the key, re-auth, retry **once**; then `raise_for_status()` + `.json()`. `httpx.HTTPError`/`ValueError`/missing-key `KeyError` → `BankProviderError` (mold: `CoinGeckoPriceProvider._get`, incl. the injected-vs-short-lived client split; short-lived clients use `base_url=PLUGGY_BASE_URL`).
- Cursor walk (shared `_get_paged(path, params)` helper): start with `params | {"pageSize": 500}`; after each page append `results`; read `next` — `None`/absent ⇒ done; else extract the `after` value: if the string contains `"after="` parse it out of the query string (`urllib.parse urlsplit/parse_qs`), otherwise treat the whole string as the token; loop with `params | {"after": token}`.
- `fetch_connections`: `_get_paged("/v2/items", {})` → map results.
- `fetch_accounts`: `_get("/accounts", {"itemId": item_id})["results"]` → map; **money**: `_to_minor(value, currency) = round(Decimal(str(value)) * 10**currency_minor_unit_exponent(currency))` (import from `pecunia.money`); missing `creditData` ⇒ the three card fields `None`; card `balance` (amount owed) is negated so a card account's provider balance is **negative**, matching Pecunia's derived credit-card balances; dates parsed with `date.fromisoformat(value[:10])`.
- `fetch_transactions`: `_get_paged("/v2/transactions", {"accountId": pluggy_account_id, "from": from_date.isoformat()})` → map; **sign normalization**: `minor = _to_minor(abs(amount), currency)`; `amount_minor = -minor if type == "DEBIT" else minor` (fixes the credit-card quirk where purchases arrive positive); `pluggy_category = row.get("category")`.

`FakeBankProvider` (hand-rolled, no mocking framework — mold `FakePriceProvider`):

```python
FakeBankProvider(
    *,
    connections: list[ProviderConnection] | None = None,
    accounts_by_item: dict[str, list[ProviderAccount]] | None = None,
    transactions_by_account: dict[str, list[ProviderTransaction]] | None = None,
    raise_all: bool = False,                      # every method raises BankProviderError
    raise_for_items: set[str] | None = None,      # fetch_accounts/... for this item raises
)
# records .transaction_calls: list[tuple[str, date]]  (pluggy_account_id, from_date)
# fetch_transactions filters its canned list to rows with row.date >= from_date
```

- [ ] **Step 1:** Failing tests (all through `httpx.MockTransport` handlers, no live HTTP): auth happens once and the key is reused across calls (count `/auth` hits); a 401 on a data call triggers exactly one re-auth + retry (second 401 → `BankProviderError`); `/v2/items` pagination follows `next` in all three shapes (full URL, `?after=...` query string, bare token) and aggregates results; account mapping incl. minor-unit conversion (`1234.56` BRL → `123456`), card-balance negation, `creditData` present/absent; transaction sign matrix (bank DEBIT → negative, bank CREDIT → positive, card purchase `amount=100.0, type=DEBIT` → `-10000`, card payment CREDIT → positive); PENDING rows pass through with `status="PENDING"`; a 500, invalid JSON body, and `httpx.TimeoutException` each → `BankProviderError`; `FakeBankProvider` returns canned data, records calls, filters by `from_date`, raises on demand.
- [ ] **Step 2–4:** implement; `uv run pytest tests/test_bank_provider.py -q` → green.
- [ ] **Step 5:** Commit `feat: Pluggy bank provider + fake (Track T)`.

---

### Task 3: `TransactionService.create(external_id=...)` + `TransactionOut.is_imported`

**Files:**
- Modify: `api/src/pecunia/services/transactions.py` (`create`), `api/src/pecunia/models/__init__.py` if needed, `api/src/pecunia/audit/allowlists.py` (`"transaction"` set gains `"external_id"`), `api/src/pecunia/activity/templates.py` (new `Activity.TRANSACTION_IMPORTED` entry mirroring `TRANSACTION_CREATED`'s params, wording "imported"), `api/src/pecunia/api/transactions.py` (`TransactionOut`)
- Test: `api/tests/test_transactions.py` (extend), `api/tests/test_transactions_api.py` or wherever `TransactionOut` shape is asserted (follow existing file split)

**Interfaces — Produces:** `TransactionService.create(..., external_id: str | None = None)` — sets the column; when `external_id is not None` the published event uses `action=Actions.TRANSACTION_IMPORTED` and `activity_template=Activity.TRANSACTION_IMPORTED` (same `activity_params`); otherwise behavior is byte-for-byte unchanged. `TransactionOut` gains `is_imported: bool` (`transaction.external_id is not None` in `from_model`). Later tasks rely on: `await TransactionService(db).create(workspace_id, account_id=..., amount_minor=..., currency=..., description=..., occurred_on=..., category_id=..., external_id=...)`.

- [ ] **Step 1:** Failing tests: create with `external_id` persists it, writes an `audit_events` row with action `transaction.imported`, and an activity entry from the new template; create without it still emits `transaction.created`; the API list/read returns `is_imported: true/false` accordingly; two creates with the same `(account_id, external_id)` raise IntegrityError at flush (the constraint from Task 1 is live).
- [ ] **Step 2–4:** implement; full API suite → green (existing transaction tests must not change behavior).
- [ ] **Step 5:** Commit `feat: transaction external_id + imported event/flag`.

---

### Task 4: `BankSyncService` (+ audit actions/allowlists)

**Files:**
- Create: `api/src/pecunia/services/banksync/sync.py`
- Modify: `api/src/pecunia/audit/actions.py`, `api/src/pecunia/audit/allowlists.py`
- Test: `api/tests/test_bank_sync.py`

**Interfaces — Consumes:** Task 2 provider types; `TransactionService.create(..., external_id=...)` (Task 3); `AccountService.create`/`AccountService.balance` (`api/src/pecunia/services/accounts.py`); `CurrencyMismatchError` from `pecunia.services.transactions`; `scoped_select`/`get_scoped`.

**Interfaces — Produces:**

```python
# actions.py — new block "# bank sync (Track T)"
BANK_CONNECTION_CREATED = "bank_connection.created"
BANK_CONNECTION_DELETED = "bank_connection.deleted"
BANK_ACCOUNT_LINKED = "bank_account.linked"
BANK_ACCOUNT_UNLINKED = "bank_account.unlinked"
BANK_SYNC_COMPLETED = "bank_sync.completed"
BANK_SYNC_FAILED = "bank_sync.failed"
BANK_CATEGORY_MAPPINGS_REPLACED = "bank_category_mapping.replaced"

# allowlists.py — new entries (ids only, never credentials)
"bank_connection": frozenset({"id", "pluggy_item_id", "institution_name", "status", "last_error", "is_demo"}),
"bank_account_link": frozenset({"id", "connection_id", "account_id", "pluggy_account_id", "sync_from", "provider_balance_minor", "is_demo"}),
"bank_category_mapping": frozenset({"id", "pluggy_category", "category_id", "is_demo"}),
```

```python
# sync.py
SYNC_OVERLAP_DAYS = 7

class ConnectionNotFoundError(Exception): ...   # router → 404
class LinkNotFoundError(Exception): ...         # router → 404
class AccountAlreadyLinkedError(Exception): ... # router → 409 ACCOUNT_ALREADY_LINKED
class PluggyAccountAlreadyLinkedError(Exception): ...  # router → 409 PLUGGY_ACCOUNT_ALREADY_LINKED
class PluggyAccountNotFoundError(Exception): ...       # router → 404 PLUGGY_ACCOUNT_NOT_FOUND

class BankSyncService:
    """Flushes, never commits. BankProviderError propagates from discover/link
    (router → 503); sync_workspace captures it per connection instead."""
    def __init__(self, db: AsyncSession, provider: BankProvider): ...

    async def discover(self, workspace_id) -> list[dict]:
        # provider.fetch_connections() + fetch_accounts() per item, each account
        # annotated with linked_account_id (from bank_account_links) or None.
        # Returns plain dicts shaped like the DiscoveryOut schema (Task 5).

    async def link_account(self, workspace_id, *, pluggy_item_id: str,
                           pluggy_account_id: str, sync_from: date, today: date,
                           account_id: uuid.UUID | None = None,
                           new_account_name: str | None = None) -> BankAccountLink:
        # 1. resolve ProviderConnection + ProviderAccount (unknown → PluggyAccountNotFoundError)
        # 2. guards: account_id already linked → AccountAlreadyLinkedError;
        #    pluggy_account_id already linked in workspace → PluggyAccountAlreadyLinkedError
        # 3. upsert BankConnection by (workspace, item) — on create emit BANK_CONNECTION_CREATED
        # 4. account: existing → get_scoped (missing → AccountNotFoundError from transactions svc)
        #    + currency guard vs provider account (CurrencyMismatchError);
        #    new → AccountService.create(name=new_account_name or provider.name,
        #      type=_account_type(provider), currency=provider.currency)
        #      where _account_type: CREDIT→credit_card, BANK/SAVINGS_ACCOUNT→savings, else checking
        # 5. create link (sync_from, card fields, provider balance) — emit BANK_ACCOUNT_LINKED
        # 6. first import via _sync_link(link, from_date=sync_from, today=today)
        # 7. anchor ONCE (import-then-anchor, order matters):
        #    account.initial_balance_minor += provider.balance_minor - await AccountService(db).balance(account)
        #    emit ACCOUNT_BALANCE_RECONCILED (before/after = project("account", ...))
        # 8. connection.status/last_synced_at updated

    async def sync_workspace(self, workspace_id, *, today: date) -> dict:
        # {"connections": int, "created": int, "skipped": int, "errors": list[str]}
        # One provider.fetch_connections() up front (item status by id). Per stored
        # connection: try — per link: window = max(link.sync_from,
        # connection.last_synced_at.date() - SYNC_OVERLAP_DAYS if set);
        # fetch_accounts(item) once per connection → refresh link.provider_balance_minor/
        # as_of/card fields; _sync_link(...) accumulates created/skipped;
        # connection.status = "ok" if item.status == "UPDATED" else "error"
        # (raw status into last_error); last_synced_at = datetime.now(UTC);
        # emit BANK_SYNC_COMPLETED — except BankProviderError → errors.append,
        # status="error", last_error=str(exc), emit BANK_SYNC_FAILED, continue.

    async def _sync_link(self, link, *, from_date: date, today: date) -> tuple[int, int]:
        # provider.fetch_transactions(link.pluggy_account_id, from_date=from_date);
        # drop status != "POSTED"; existing = select Transaction.external_id where
        # account_id == link.account_id and external_id.in_(ids)  — NO deleted_at
        # filter (soft-deleted rows are tombstones); mappings preloaded once into
        # {pluggy_category: category_id}; each new row →
        # TransactionService.create(..., category_id=mapping.get(cat), external_id=...)
        # returns (created, skipped)

    async def list_connections(self, workspace_id) -> list[dict]:
        # stored connections + links, each link with derived_balance_minor
        # (AccountService.balance) + account name/currency — shaped for ConnectionsOut

    async def reconcile(self, workspace_id, link_id, *, today: date) -> Transaction | None:
        # gap = link.provider_balance_minor - balance(account); 0 → None;
        # else TransactionService.create(amount_minor=gap, description=
        # "Ajuste de reconciliação", occurred_on=today, external_id=None)
        # + emit ACCOUNT_BALANCE_RECONCILED

    async def unlink(self, workspace_id, link_id) -> None:      # delete link, emit BANK_ACCOUNT_UNLINKED (connection stays)
    async def delete_connection(self, workspace_id, connection_id) -> None:  # links CASCADE; emit BANK_CONNECTION_DELETED
    async def list_mappings(self, workspace_id) -> list[BankCategoryMapping]:
    async def replace_mappings(self, workspace_id, mappings: list[tuple[str, uuid.UUID]]) -> list[BankCategoryMapping]:
        # validate every category via get_scoped (missing → CategoryNotFoundError
        # from transactions svc); delete-all + insert; one event
        # BANK_CATEGORY_MAPPINGS_REPLACED with after={"count": len(mappings)}
```

- [ ] **Step 1:** Failing tests in `test_bank_sync.py` (all `FakeBankProvider`, real Postgres, fixture workspace from `initialized_instance`): link-to-existing (currency guard raises on mismatch); link-creates-account with derived type/currency/name; duplicate-link guards (both flavors); **anchor math** — provider balance 500.00, one imported tx of −100.00 onto an account whose prior manual balance was 250.00 ⇒ `initial_balance_minor` adjusted so `AccountService.balance` == 50000 after link; re-sync dedupes (second `sync_workspace` creates 0, skips N); tombstone — soft-delete one imported tx, re-sync, still absent and not recreated; overlap window — `fetch_transactions` called with `last_synced_at − 7d`, never earlier than `sync_from`; PENDING dropped; category mapping hit/miss; card fields + negative card provider balance stored; one connection raising `BankProviderError` doesn't stop the second (summary has 1 error, other connection synced, statuses ok/error + BANK_SYNC_FAILED audit row); item status LOGIN_ERROR ⇒ connection error + raw status in `last_error`; `reconcile` posts exactly the gap then balance matches (and returns None at gap 0); unlink keeps transactions + connection; `delete_connection` removes links; `replace_mappings` validates categories and round-trips; audit rows exist for linked/imported/reconciled/completed.
- [ ] **Step 2–4:** implement; `uv run pytest tests/test_bank_sync.py -q` then full suite → green.
- [ ] **Step 5:** Commit `feat: bank sync service (link, import, anchor, reconcile)`.

---

### Task 5: `/api/v1/bank-sync` router

**Files:**
- Create: `api/src/pecunia/api/banksync.py`
- Modify: `api/src/pecunia/main.py` (import + `app.include_router(banksync_router, prefix="/api/v1")`)
- Test: `api/tests/test_banksync_api.py`

**Interfaces — Consumes:** Task 4 service + exceptions; Task 2 `PluggyProvider`/`BankProviderError`. **Produces** (`router = APIRouter(prefix="/bank-sync", tags=["bank-sync"])`, every route `Depends(require_workspace)` + `get_db`, mutations commit once):

```python
def get_bank_provider(request: Request) -> BankProvider:
    # settings = get_settings(); missing client_id/secret →
    # HTTPException(503, "BANK_PROVIDER_UNAVAILABLE");
    # else lazily cache PluggyProvider(client_id, client_secret) on
    # request.app.state.bank_provider (mold: get_price_provider)

# Schemas (resource + In/Out):
class BankLinkOut(BaseModel):        # id, account_id, account_name, account_currency, pluggy_account_id, sync_from, provider_balance_minor, provider_balance_as_of, derived_balance_minor, credit_limit_minor, bill_close_date, bill_due_date
class BankConnectionOut(BaseModel):  # id, institution_name, status, last_error, last_synced_at, links: list[BankLinkOut]
class DiscoveredAccountOut(BaseModel):  # pluggy_account_id, type, subtype, name, number, balance_minor, currency, linked_account_id: uuid | None
class DiscoveredConnectionOut(BaseModel)  # item_id, institution_name, status, accounts: list[DiscoveredAccountOut]
class NewAccountIn(BaseModel): name: str | None = None
class LinkIn(BaseModel):             # pluggy_item_id: str, pluggy_account_id: str, sync_from: date, account_id: uuid | None = None, new_account: NewAccountIn | None = None  (validator: exactly one of account_id / new_account)
class SyncSummaryOut(BaseModel):     # connections, created, skipped, errors: list[str]
class CategoryMappingIn/Out(BaseModel):  # pluggy_category: str, category_id: uuid
class MappingsIn(BaseModel): mappings: list[CategoryMappingIn]

GET  /bank-sync/discovery            -> list[DiscoveredConnectionOut]   # BankProviderError → 503 BANK_PROVIDER_UNAVAILABLE
GET  /bank-sync/connections          -> list[BankConnectionOut]         # stored state only, works offline
POST /bank-sync/links                -> BankConnectionOut (201)         # runs first sync; 409 ACCOUNT_ALREADY_LINKED / PLUGGY_ACCOUNT_ALREADY_LINKED, 422 CURRENCY_MISMATCH, 404 ACCOUNT_NOT_FOUND / PLUGGY_ACCOUNT_NOT_FOUND, 503 provider
DELETE /bank-sync/links/{link_id}    -> 204                             # 404 LINK_NOT_FOUND
POST /bank-sync/links/{link_id}/reconcile -> 200 TransactionOut (adjustment posted) | 204 (gap == 0, nothing posted)  # 404 LINK_NOT_FOUND
POST /bank-sync/sync                 -> SyncSummaryOut                  # today=datetime.now(UTC).date(), mold refresh_prices
GET  /bank-sync/category-mappings    -> list[CategoryMappingOut]
PUT  /bank-sync/category-mappings    -> list[CategoryMappingOut]        # 404 CATEGORY_NOT_FOUND
DELETE /bank-sync/connections/{id}   -> 204                             # 404 CONNECTION_NOT_FOUND
```

- [ ] **Step 1:** Failing tests (ASGI client, `app.dependency_overrides[get_bank_provider]` → `FakeBankProvider`): discovery shape + linked annotation; link happy paths (existing + new account) return the connection with the link and the first import already visible via `/transactions`; every error mapping above (409/422/404 pairs); sync returns the summary; reconcile 200-with-body vs 204; mappings PUT validates + GET round-trips; connection delete; provider raising → 503 `BANK_PROVIDER_UNAVAILABLE`; **no-credentials 503** — a client built without overriding `get_bank_provider` (default empty settings) gets 503 on `/discovery`; all routes 401 unauthenticated.
- [ ] **Step 2–4:** implement + register router; full suite → green.
- [ ] **Step 5:** Commit `feat: bank-sync API (discovery, links, sync, mappings)`.

---

### Task 6: Daily job + config + egress docs

**Files:**
- Modify: `api/src/pecunia/config.py`, `api/src/pecunia/scheduler.py`, `api/src/pecunia/main.py` (lifespan), `api/tests/conftest.py` (force flag off, next to the price-sync line), `.env.example`, `docker-compose.yml` (api environment passthrough), `README.md` (Network egress section)
- Test: `api/tests/test_scheduler.py` (extend), `api/tests/test_config.py` if present (follow existing)

**Interfaces — Produces:**

```python
# config.py (comments in the file's style: what it gates, default posture)
pluggy_client_id: str = ""
pluggy_client_secret: str = ""
enable_bank_sync: bool = True   # inert without both credentials

# scheduler.py
BANK_SYNC_INTERVAL_SECONDS = 24 * 60 * 60
async def run_daily_bank_sync(sessionmaker, provider: BankProvider, *, today: date) -> dict[str, dict]:
    # mirror run_daily_price_sync: one session for workspace ids, then per
    # workspace one session + try/except + BankSyncService(db, provider)
    # .sync_workspace(...) + commit; logger.exception on failure; summary per id
async def _bank_sync_loop(sessionmaker, provider) -> None:   # initial sleep 120 (offset from price sync's 60), then every 24h
def start_bank_sync_task(settings, sessionmaker, *, provider: BankProvider | None = None) -> asyncio.Task | None:
    # gate: enable_bank_sync AND pluggy_client_id AND pluggy_client_secret,
    # else None; default provider = PluggyProvider(settings.pluggy_client_id, settings.pluggy_client_secret)
```

`main.py` lifespan: `bank_sync_task = start_bank_sync_task(settings, sessionmaker)` stored on `app.state.bank_sync_task`, cancelled on shutdown exactly like `price_sync_task`. `.env.example`: the three vars with one-line comments. `docker-compose.yml`: pass `PECUNIA_PLUGGY_CLIENT_ID`, `PECUNIA_PLUGGY_CLIENT_SECRET`, `PECUNIA_ENABLE_BANK_SYNC` through to the api service like the existing vars. README egress: `api.pluggy.ai` joins CoinGecko as the second documented outbound call — optional, off without credentials, credentials only ever in the local env.

- [ ] **Step 1:** Failing tests: `run_daily_bank_sync` syncs two workspaces via the fake and a raising workspace doesn't stop the other; `start_bank_sync_task` returns `None` when the flag is false, `None` when either credential is empty, a task when all three are set (cancel it in the test); settings read the `PECUNIA_PLUGGY_*` env vars.
- [ ] **Step 2–4:** implement + docs edits; full suite → green (conftest flag keeps lifespan tests quiet).
- [ ] **Step 5:** Commit `feat: daily bank sync job gated by PECUNIA_ENABLE_BANK_SYNC`.

---

### Task 7: Frontend — Connections settings panel

**Files:**
- Create: `web/src/features/banksync/useBankSync.ts`, `web/src/features/banksync/ConnectionsPanel.tsx`, `web/src/features/banksync/LinkDialog.tsx`, `web/src/features/banksync/CategoryMappingEditor.tsx` + co-located `.test.tsx` for each
- Modify: `web/src/lib/queries.ts` (new key + docstring in the file's style), `web/src/features/settings/SettingsScreen.tsx` (register panel `connections` in `PANELS` + a "Connections" item in the subnav's General group)

**Interfaces — Consumes:** Task 5 endpoints. **Produces:**

```ts
// queries.ts
bankSync: ["bank-sync"] as const,   // hooks suffix: ["bank-sync","connections"], ["bank-sync","discovery"], ["bank-sync","mappings"]

// useBankSync.ts — types mirroring the Out schemas (BankLinkOut, BankConnectionOut,
// DiscoveredConnectionOut, SyncSummaryOut, CategoryMapping) + hooks:
useBankConnections()          // GET connections
useBankDiscovery(enabled)     // GET discovery — fetched only while the LinkDialog is open; surfaces 503 as a degraded state
useLinkAccount()              // POST links
useUnlinkAccount()            // DELETE links/{id}
useDeleteConnection()         // DELETE connections/{id}
useSyncNow()                  // POST sync
useReconcile()                // POST links/{id}/reconcile
useCategoryMappings()         // GET category-mappings
useReplaceMappings()          // PUT category-mappings
// Mutations that import/adjust transactions (link, sync, reconcile) invalidate
// qk.bankSync + qk.accounts + qk.transactions() + ["analytics"]; unlink/delete/
// mappings invalidate qk.bankSync only (mappings also nothing else — they only
// affect FUTURE imports).
```

`ConnectionsPanel`: list of connection cards (institution, status dot ok/error with `last_error`, relative `last_synced_at`, "Sync now" button → summary toast "N imported, M skipped", delete), each link row showing account name, bank balance vs Pecunia balance, a **divergence badge** when `provider_balance_minor !== derived_balance_minor` with a "Reconcile" button (confirm dialog stating the adjustment amount), card rows adding limit + close/due dates, unlink action; "Link an account" button opening `LinkDialog`; `CategoryMappingEditor` beneath (add/remove rows: free-text Pluggy category + category select from `useCategories`, save via PUT). Empty state explains Meu Pluggy + that credentials must be configured (shown on 503 from discovery). `LinkDialog`: discovered accounts not yet linked → per account choose existing account (same-currency options only) or "create new" with optional name override, `sync_from` date input defaulting to today. Tailwind `--pc-*` tokens, responsive (`flex-wrap`, `min-w-0`).

- [ ] **Step 1:** Failing Vitest (mock `apiFetch` via the established `vi.mock("../../lib/api", ...)` seam): panel renders connections/links, divergence badge only when balances differ, sync-now posts and toasts the summary, reconcile confirms then posts, wizard filters already-linked accounts + same-currency existing options + posts the right body (existing and new-account variants), mapping editor round-trips add/remove/save, 503 discovery → degraded copy, settings screen shows the new section and renders the panel.
- [ ] **Step 2–4:** implement; `npm run build && npm run lint && npm run test` → green, 0 new warnings.
- [ ] **Step 5:** Commit `feat(web): bank connections settings panel`.

---

### Task 8: Frontend — imported/linked markers on existing screens

**Files:**
- Modify: `web/src/features/transactions/useTransactions.ts` (type gains `is_imported: boolean`), the transactions list row component (small "OF" marker/icon with `title="Imported via Open Finance"` when `is_imported`), `web/src/features/accounts/AccountsScreen.tsx` + `web/src/features/accounts/AccountDetail.tsx` (an "Open Finance" chip on linked accounts; on a linked credit card's detail: limit + close/due dates) — accounts learn their link via `useBankConnections()` mapped by `account_id`
- Test: co-located tests extended alongside each change

**Interfaces — Consumes:** `TransactionOut.is_imported` (Task 3), `useBankConnections` (Task 7).

- [ ] **Step 1:** Failing Vitest: a transaction row with `is_imported: true` shows the marker (and not otherwise); a linked account shows the chip; an unlinked one doesn't; a linked credit card's detail shows limit/close/due from the link.
- [ ] **Step 2–4:** implement; `npm run build && npm run lint && npm run test` → green.
- [ ] **Step 5:** Commit `feat(web): open-finance markers on accounts and transactions`.

---

## Self-review notes

- **Coverage vs spec:** tables+column (T1); provider+fake+normalization (T2); imported event/flag (T3); link/anchor/dedupe/tombstone/window/reconcile/mappings/status-mapping + audit (T4); every endpoint + provider dependency + 503s (T5); job+gate+config+egress docs (T6); Connections panel+wizard+mappings UI (T7); markers+card fields (T8). Spec's "PENDING skipped" lives in T4 (service filters; provider passes through).
- **Consistency:** `external_id` name used across T1/T3/T4; `BankProvider`/`FakeBankProvider` signatures identical in T2/T4/T5/T6; summary dict keys `{connections, created, skipped, errors}` in T4/T5/T7; card provider balance is negative everywhere (T2 negation → T4 storage → T7 divergence compare).
- **Order matters:** anchor AFTER first import (T4 step list is explicit); housekeeping lists updated in T1, not later; router registered before any `/{id}`-style collision (flat prefix, no conflict).
- **Deferred (per spec):** investments, webhooks, `PATCH /items`, bills API, transfer auto-matching, category rule learning.
