# Subscription Detector (Track W) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect recurring charges from imported bank/card transactions and suggest them as editable, user-confirmed subscriptions, and break subscription spend down by category — building on the existing Subscription domain without rebuilding it.

**Architecture:** Capture Pluggy's merchant name onto `transactions` (new nullable column, migration 0006) so recurrence can key on a stable merchant instead of noisy free text. A clock-free `SubscriptionDetector` groups a workspace's imported expenses by `(merchant, currency)`, keeps a modal-amount cluster, infers cadence from the median date gap, and emits candidates via a read-only `GET /subscriptions/suggestions`. The frontend shows candidates on the Subscriptions screen; "Add" opens the existing `SubscriptionForm` pre-filled, so confirming reuses `POST /subscriptions` (no new write path). `GET /subscriptions/totals` gains a per-category breakdown.

**Tech Stack:** FastAPI + SQLAlchemy 2 async + Alembic + Postgres (api/); React 18 + TS + Vite + Tailwind v4 + TanStack Query (web/). pytest + testcontainers; Vitest + Testing Library.

## Global Constraints

- Money is integer minor units, **never summed across currencies** (per-currency maps). (`docs/CONVENTIONS.md` §4)
- Services **flush, never commit** — the router owns the transaction boundary. (§2)
- Services are **clock-free** — `today: date` is passed in, never read from the clock. (§4)
- New migration is hand-written, `revision = "0006"`, `down_revision = "0005"`, with a real `downgrade`; `compare_metadata` parity must stay green.
- Conventional commits, **NO co-author/session trailers** (Pecunia rule).
- Frontend: Tailwind `--pc-*`/semantic tokens only (no raw hex); `MoneyText`/`DateText`; the `qk` query-key factory; co-located Vitest tests.
- **New UI copy is English**, matching the existing `SubscriptionsScreen`/`SubscriptionForm` (the design doc's Portuguese strings were illustrative; this screen is English and must stay internally consistent — do NOT translate the rest of the screen).
- Suggestions are **suggest-and-confirm**: nothing becomes a `Subscription` without the user confirming through the form.
- TDD throughout. `uv run pytest` green in `api/`; `npm run build && npm run lint && npm run test` green in `web/`, 0 new warnings, before each commit that completes a task.

---

## File Structure

**Backend**
- `api/alembic/versions/0006_transaction_merchant.py` — **new**: add `transactions.merchant` (nullable Text).
- `api/src/pecunia/models/transaction.py` — **modify**: add `merchant` mapped column.
- `api/src/pecunia/services/banksync/provider.py` — **modify**: `ProviderTransaction.merchant` + `_map_transaction` reads Pluggy `merchant`.
- `api/src/pecunia/services/transactions.py` — **modify**: `create(..., merchant=None)` sets the column.
- `api/src/pecunia/services/banksync/sync.py` — **modify**: `_sync_link` passes `merchant=row.merchant`.
- `api/src/pecunia/audit/allowlists.py` — **modify**: add `"merchant"` to the `transaction` allowlist.
- `api/src/pecunia/api/transactions.py` — **modify**: `TransactionOut.merchant`.
- `api/src/pecunia/services/subscription_detect.py` — **new**: `DetectTxn`, `ExistingSub`, `SubscriptionCandidate`, pure `detect_candidates(...)`, and `SubscriptionDetector`.
- `api/src/pecunia/services/subscriptions.py` — **modify**: `totals(...)` adds a per-category breakdown.
- `api/src/pecunia/api/subscriptions.py` — **modify**: `SubscriptionSuggestionOut`, `GET /subscriptions/suggestions`; `CategorySubtotal` + `by_category` on `CurrencyTotal`.

**Frontend**
- `web/src/features/subscriptions/useSubscriptions.ts` — **modify**: `SubscriptionSuggestion` type + `useSubscriptionSuggestions()`; extend `CurrencyTotal` with `by_category`.
- `web/src/features/subscriptions/SubscriptionForm.tsx` — **modify**: `initialValues?: SubscriptionFormInitial` (create-mode prefill).
- `web/src/features/subscriptions/SubscriptionSuggestions.tsx` (+ `.test.tsx`) — **new**: the candidate review section.
- `web/src/features/subscriptions/SubscriptionsScreen.tsx` — **modify**: mount suggestions, wire Add→prefilled form & Ignore; add by-category rows to the header.

**Tests (new):**
- `api/tests/test_migration_0006_transaction_merchant.py`
- `api/tests/services/test_subscription_detect.py`
- `api/tests/api/test_subscription_suggestions.py`
- `api/tests/api/test_subscription_totals_by_category.py`
- (extend existing provider + sync + transactions-API tests for merchant)
- `web/src/features/subscriptions/SubscriptionSuggestions.test.tsx`

---

### Task 1: Migration 0006 + `Transaction.merchant` column

**Files:**
- Create: `api/alembic/versions/0006_transaction_merchant.py`
- Modify: `api/src/pecunia/models/transaction.py:58` (after `external_id`)
- Test: `api/tests/test_migration_0006_transaction_merchant.py`

**Interfaces:**
- Produces: `Transaction.merchant: Mapped[str | None]` (nullable `Text`), migration revision `"0006"` (down_revision `"0005"`).

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_migration_0006_transaction_merchant.py`. Mirror the structure of the existing migration tests (check one: `ls api/tests/test_migration*`). It must assert (a) a `Transaction` can be inserted with a `merchant` value and read back, and (b) `merchant` is nullable (insert with `merchant=None` succeeds). Use the same session/fixtures the other `api/tests/` DB tests use (testcontainers Postgres, migrations applied).

```python
import uuid
from datetime import date

import sqlalchemy as sa

from pecunia.models.transaction import Transaction


async def test_transaction_merchant_roundtrips_and_is_nullable(db_session, seed_workspace_account):
    ws_id, account_id = seed_workspace_account
    with_merchant = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account_id,
        amount_minor=-1990, currency="BRL", description="NETFLIX",
        occurred_on=date(2026, 9, 1), external_id="ext-1", merchant="Netflix",
    )
    without = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account_id,
        amount_minor=-500, currency="BRL", description="manual",
        occurred_on=date(2026, 9, 2),
    )
    db_session.add_all([with_merchant, without])
    await db_session.flush()
    stored = (await db_session.execute(
        sa.select(Transaction.merchant).where(Transaction.id == with_merchant.id)
    )).scalar_one()
    assert stored == "Netflix"
    null_stored = (await db_session.execute(
        sa.select(Transaction.merchant).where(Transaction.id == without.id)
    )).scalar_one()
    assert null_stored is None
```

> If the repo's DB-test fixtures are named differently (e.g. `session`, `workspace`), adapt the fixture names to match the ones the neighboring `api/tests/` tests already use — read one first. Do NOT invent new fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_migration_0006_transaction_merchant.py -v`
Expected: FAIL — `AttributeError`/`TypeError` on `merchant` (column/kwarg not defined) or a DB error that `transactions.merchant` does not exist.

- [ ] **Step 3: Add the model column**

In `api/src/pecunia/models/transaction.py`, directly after the `external_id` column (line 58), add:

```python
    # The counterparty/merchant name from the provider (Track W) — Pluggy's
    # structured `merchant.name`/`businessName`, captured so the subscription
    # detector can key recurrence on a stable name instead of the noisy free
    # `description`. NULL for manual rows and for imported rows that predate
    # this column (backfilled operationally) or that carried no merchant.
    merchant: Mapped[str | None] = mapped_column(Text)
```

(`Text` and `Mapped`/`mapped_column` are already imported in this file.)

- [ ] **Step 4: Write the migration**

Create `api/alembic/versions/0006_transaction_merchant.py`:

```python
"""Add transactions.merchant (Track W — subscription detector)

Captures the provider's structured merchant/counterparty name on imported
transactions so recurring-charge detection can group by a stable merchant
rather than the free-text `description`. Nullable and additive: manual rows,
and imported rows that predate this column, simply carry NULL.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("merchant", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("transactions", "merchant")
```

- [ ] **Step 5: Run the migration test + parity test**

Run: `cd api && uv run pytest tests/test_migration_0006_transaction_merchant.py -v`
Expected: PASS.

Run the metadata-parity test (find it: `grep -rl "compare_metadata" api/tests`). Example:
Run: `cd api && uv run pytest -k "parity or compare_metadata or no_pending_migration" -v`
Expected: PASS — the model and migration agree, no pending autogenerate diff.

- [ ] **Step 6: Commit**

```bash
cd api && git add alembic/versions/0006_transaction_merchant.py src/pecunia/models/transaction.py tests/test_migration_0006_transaction_merchant.py
git commit -m "feat(api): add transactions.merchant column (migration 0006)"
```

---

### Task 2: Provider captures Pluggy merchant

**Files:**
- Modify: `api/src/pecunia/services/banksync/provider.py:104-113` (`ProviderTransaction`) and `:377-391` (`_map_transaction`)
- Test: the existing provider test module (find it: `grep -rl "_map_transaction\|ProviderTransaction\|MockTransport\|map_transaction" api/tests`)

**Interfaces:**
- Consumes: `Transaction.merchant` (Task 1).
- Produces: `ProviderTransaction.merchant: str | None`; `_map_transaction` populates it from `row["merchant"]["name"]` → `["merchant"]["businessName"]` → `None`.

- [ ] **Step 1: Write the failing tests**

In the provider test module, add three cases driving `_map_transaction` (or the public `fetch_transactions` via the existing `MockTransport`, matching how that module already tests mapping — read it first). Assert the merchant mapping for: (a) full `merchant` object with `name`; (b) `merchant` with only `businessName`; (c) no `merchant` key.

```python
def test_map_transaction_captures_merchant_name():
    provider = PluggyProvider("id", "secret")
    row = {
        "id": "t1", "date": "2026-09-01T00:00:00.000Z", "description": "NETFLIX.COM",
        "amount": 19.90, "currencyCode": "BRL", "type": "DEBIT", "status": "POSTED",
        "merchant": {"name": "Netflix", "businessName": "Netflix Servicos"},
    }
    tx = provider._map_transaction(row)
    assert tx.merchant == "Netflix"


def test_map_transaction_falls_back_to_business_name():
    provider = PluggyProvider("id", "secret")
    row = {
        "id": "t2", "date": "2026-09-01T00:00:00.000Z", "description": "SPOTIFY",
        "amount": 21.90, "currencyCode": "BRL", "type": "DEBIT", "status": "POSTED",
        "merchant": {"businessName": "Spotify Brasil"},
    }
    assert provider._map_transaction(row).merchant == "Spotify Brasil"


def test_map_transaction_merchant_absent_is_none():
    provider = PluggyProvider("id", "secret")
    row = {
        "id": "t3", "date": "2026-09-01T00:00:00.000Z", "description": "PIX",
        "amount": 50.0, "currencyCode": "BRL", "type": "DEBIT", "status": "POSTED",
    }
    assert provider._map_transaction(row).merchant is None
```

> Match the module's existing import of `PluggyProvider` and its constructor arity — read a neighboring test in the same file and copy the construction idiom exactly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest <provider_test_path> -k merchant -v`
Expected: FAIL — `ProviderTransaction` has no `merchant` / `tx.merchant` AttributeError.

- [ ] **Step 3: Add the dataclass field**

In `provider.py`, in `ProviderTransaction` (after `pluggy_category` at line 112), add:

```python
    merchant: str | None = None  # Pluggy's merchant.name / businessName, else None
```

(A default keeps every existing `ProviderTransaction(...)` call site in tests valid.)

- [ ] **Step 4: Populate it in `_map_transaction`**

In `_map_transaction`, before the `return`, read the merchant tolerantly (mirrors the file's partial-`creditData` handling), then pass it:

```python
        merchant_obj = row.get("merchant") or {}
        merchant = merchant_obj.get("name") or merchant_obj.get("businessName")
        return ProviderTransaction(
            external_id=row["id"],
            date=date.fromisoformat(row["date"][:10]),
            description=row["description"],
            amount_minor=amount_minor,
            currency=currency,
            status=row["status"],
            pluggy_category=row.get("category"),
            merchant=merchant,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest <provider_test_path> -v`
Expected: PASS (all three new cases + the module's existing provider tests).

- [ ] **Step 6: Commit**

```bash
cd api && git add src/pecunia/services/banksync/provider.py <provider_test_path>
git commit -m "feat(api): capture Pluggy merchant in ProviderTransaction"
```

---

### Task 3: Persist merchant through import + expose on `TransactionOut`

**Files:**
- Modify: `api/src/pecunia/services/transactions.py:101-151` (`create`)
- Modify: `api/src/pecunia/services/banksync/sync.py:506-515` (`_sync_link` create call)
- Modify: `api/src/pecunia/audit/allowlists.py:16-21` (`transaction` allowlist)
- Modify: `api/src/pecunia/api/transactions.py` (`TransactionOut`)
- Test: existing transactions-service test + sync test + transactions-API test (find them: `grep -rl "TransactionService\|def test_sync_link\|_sync_link\|TransactionOut" api/tests`)

**Interfaces:**
- Consumes: `Transaction.merchant` (Task 1), `ProviderTransaction.merchant` (Task 2).
- Produces: `TransactionService.create(..., merchant: str | None = None)`; `TransactionOut.merchant: str | None`.

- [ ] **Step 1: Write the failing tests**

(a) In the transactions-service test module, assert `create` persists merchant:

```python
async def test_create_persists_merchant(db_session, seed_workspace_account):
    ws_id, account_id = seed_workspace_account
    svc = TransactionService(db_session)
    tx = await svc.create(
        ws_id, account_id=account_id, amount_minor=-1990, currency="BRL",
        description="NETFLIX", occurred_on=date(2026, 9, 1),
        external_id="ext-9", merchant="Netflix",
    )
    assert tx.merchant == "Netflix"


async def test_create_merchant_defaults_none(db_session, seed_workspace_account):
    ws_id, account_id = seed_workspace_account
    svc = TransactionService(db_session)
    tx = await svc.create(
        ws_id, account_id=account_id, amount_minor=-500, currency="BRL",
        description="manual", occurred_on=date(2026, 9, 2),
    )
    assert tx.merchant is None
```

(b) In the sync test module, extend the "import creates transactions" test (or add one) so a `ProviderTransaction(..., merchant="Spotify")` fed through `FakeBankProvider` lands on the created row's `merchant`. Read how that module seeds `transactions_by_account` and asserts created rows, and follow it exactly. Core assertion:

```python
    created = (await db_session.execute(
        sa.select(Transaction).where(Transaction.external_id == "ext-spotify")
    )).scalar_one()
    assert created.merchant == "Spotify"
```

(c) In the transactions-API test module, assert the serialized transaction carries `merchant` (pick the existing "GET returns transaction" style test and add the field, using a row created with a merchant).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest <transactions_service_test> <sync_test> <transactions_api_test> -k merchant -v`
Expected: FAIL — `create() got an unexpected keyword argument 'merchant'` / serialized dict has no `merchant`.

- [ ] **Step 3: Thread `merchant` through `create`**

In `transactions.py` `create`, add the parameter after `external_id` (line 113):

```python
        external_id: str | None = None,
        merchant: str | None = None,
    ) -> Transaction:
```

and set it on the `Transaction(...)` constructor (after `external_id=external_id,` at line 150):

```python
            external_id=external_id,
            merchant=merchant,
        )
```

- [ ] **Step 4: Pass it from `_sync_link`**

In `sync.py` `_sync_link`, in the `tx_service.create(...)` call (lines 506-515), add after `external_id=row.external_id,`:

```python
                external_id=row.external_id,
                merchant=row.merchant,
            )
```

- [ ] **Step 5: Allowlist + `TransactionOut`**

In `allowlists.py`, add `"merchant"` to the `transaction` frozenset (line 16-21):

```python
    "transaction": frozenset(
        {
            "id", "account_id", "category_id", "contact_id", "project_id", "transfer_id",
            "amount_minor", "currency", "description", "occurred_on", "is_demo", "external_id",
            "merchant",
        }
    ),
```

In `api/transactions.py`, add `merchant: str | None` to `TransactionOut` (next to `external_id`) and map it in `from_model`/the constructor the same way `external_id` is mapped. (Read the file to match its serialization idiom — if it uses `from_attributes`/`model_validate`, no mapping line is needed; if it constructs fields explicitly, add `merchant=tx.merchant`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest <transactions_service_test> <sync_test> <transactions_api_test> -v`
Expected: PASS. Also run the audit no-secret-leak test (`uv run pytest -k "no_secret_leak or allowlist" -v`) — PASS.

- [ ] **Step 7: Commit**

```bash
cd api && git add src/pecunia/services/transactions.py src/pecunia/services/banksync/sync.py src/pecunia/audit/allowlists.py src/pecunia/api/transactions.py <test paths>
git commit -m "feat(api): persist merchant on import and expose on TransactionOut"
```

---

### Task 4: `SubscriptionDetector` + `GET /subscriptions/suggestions`

**Files:**
- Create: `api/src/pecunia/services/subscription_detect.py`
- Modify: `api/src/pecunia/api/subscriptions.py` (add `SubscriptionSuggestionOut` + the route, before `/{subscription_id}`)
- Test: `api/tests/services/test_subscription_detect.py` (pure), `api/tests/api/test_subscription_suggestions.py` (endpoint)

**Interfaces:**
- Consumes: `Transaction` (with `merchant`, Task 1-3), `Subscription`, `period.advance`, `scoped_select`.
- Produces:
  - `detect_candidates(txns: list[DetectTxn], *, today: date, existing: list[ExistingSub]) -> list[SubscriptionCandidate]` (pure).
  - `SubscriptionDetector(db).suggest(workspace_id: uuid.UUID, *, today: date) -> list[SubscriptionCandidate]`.
  - `SubscriptionCandidate` fields: `merchant, suggested_name, amount_minor, currency, billing_frequency, occurrences, first_seen, last_seen, suggested_next_renewal, suggested_category_id`.

- [ ] **Step 1: Write the failing pure-logic tests**

Create `api/tests/services/test_subscription_detect.py`:

```python
import uuid
from datetime import date

from pecunia.services.subscription_detect import (
    DetectTxn,
    ExistingSub,
    detect_candidates,
)


def _txn(merchant, amount_minor, day, *, currency="BRL", category_id=None):
    return DetectTxn(
        merchant=merchant, currency=currency, amount_minor=amount_minor,
        occurred_on=day, category_id=category_id,
    )


def test_monthly_merchant_three_equal_charges_is_one_candidate():
    txns = [
        _txn("Netflix", -1990, date(2026, 7, 5)),
        _txn("Netflix", -1990, date(2026, 8, 5)),
        _txn("Netflix", -1990, date(2026, 9, 5)),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert len(out) == 1
    c = out[0]
    assert c.merchant == "Netflix"
    assert c.suggested_name == "Netflix"
    assert c.amount_minor == 1990              # positive magnitude
    assert c.currency == "BRL"
    assert c.billing_frequency == "monthly"
    assert c.occurrences == 3
    assert c.first_seen == date(2026, 7, 5)
    assert c.last_seen == date(2026, 9, 5)
    assert c.suggested_next_renewal == date(2026, 10, 5)  # advance(last, monthly)
    assert c.suggested_category_id is None


def test_amount_within_tolerance_kept_outside_dropped():
    # 19.90, 20.80 (~+4.5%, kept), 30.00 (+50%, dropped) -> 2 kept, monthly
    txns = [
        _txn("Spotify", -1990, date(2026, 7, 10)),
        _txn("Spotify", -2080, date(2026, 8, 10)),
        _txn("Spotify", -3000, date(2026, 9, 10)),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert len(out) == 1
    assert out[0].occurrences == 2
    assert out[0].billing_frequency == "monthly"


def test_irregular_gaps_not_a_candidate():
    txns = [
        _txn("Mercado", -5000, date(2026, 7, 3)),
        _txn("Mercado", -5000, date(2026, 7, 19)),   # 16d
        _txn("Mercado", -5000, date(2026, 9, 2)),    # 45d — median gap 30? no: gaps [16,45] median 30.5 -> but spread is irregular
    ]
    # Two gaps 16 and 45; median 30.5 would bucket monthly, but we require the
    # gaps to be consistent — see Step 3's rule. This asserts the irregular set
    # is rejected.
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert out == []


def test_single_occurrence_not_a_candidate():
    out = detect_candidates([_txn("Once", -1000, date(2026, 9, 1))], today=date(2026, 10, 6), existing=[])
    assert out == []


def test_income_and_positive_amounts_ignored():
    # Caller passes only expenses, but guard anyway: a positive amount is not a charge.
    txns = [
        _txn("Salary", 500000, date(2026, 7, 1)),
        _txn("Salary", 500000, date(2026, 8, 1)),
        _txn("Salary", 500000, date(2026, 9, 1)),
    ]
    assert detect_candidates(txns, today=date(2026, 10, 6), existing=[]) == []


def test_existing_active_subscription_excluded():
    txns = [
        _txn("Netflix", -1990, date(2026, 7, 5)),
        _txn("Netflix", -1990, date(2026, 8, 5)),
        _txn("Netflix", -1990, date(2026, 9, 5)),
    ]
    existing = [ExistingSub(name="Netflix", currency="BRL", amount_minor=1990, billing_frequency="monthly")]
    assert detect_candidates(txns, today=date(2026, 10, 6), existing=existing) == []


def test_suggested_category_is_group_mode():
    cat = uuid.uuid4()
    txns = [
        _txn("Netflix", -1990, date(2026, 7, 5), category_id=cat),
        _txn("Netflix", -1990, date(2026, 8, 5), category_id=cat),
        _txn("Netflix", -1990, date(2026, 9, 5), category_id=None),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert out[0].suggested_category_id == cat


def test_currencies_isolated():
    txns = [
        _txn("Dropbox", -1000, date(2026, 7, 5), currency="BRL"),
        _txn("Dropbox", -1000, date(2026, 8, 5), currency="BRL"),
        _txn("Dropbox", -1200, date(2026, 7, 5), currency="USD"),
        _txn("Dropbox", -1200, date(2026, 8, 5), currency="USD"),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert {c.currency for c in out} == {"BRL", "USD"}
    assert len(out) == 2


def test_sorted_by_amount_desc():
    txns = [
        _txn("Small", -1000, date(2026, 7, 1)), _txn("Small", -1000, date(2026, 8, 1)),
        _txn("Big", -9000, date(2026, 7, 1)), _txn("Big", -9000, date(2026, 8, 1)),
    ]
    out = detect_candidates(txns, today=date(2026, 10, 6), existing=[])
    assert [c.merchant for c in out] == ["Big", "Small"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && uv run pytest tests/services/test_subscription_detect.py -v`
Expected: FAIL — `ModuleNotFoundError: pecunia.services.subscription_detect`.

- [ ] **Step 3: Implement the pure detector**

Create `api/src/pecunia/services/subscription_detect.py`:

```python
"""Recurring-charge detection (Track W). A clock-free, suggest-and-confirm
detector: it NEVER writes — it reads a workspace's imported expenses and
proposes `SubscriptionCandidate`s the user confirms through the normal
subscription create form. The core (`detect_candidates`) is a pure function
over lightweight `DetectTxn` rows so the grouping/cadence rules are unit-
testable without a database; `SubscriptionDetector` is the thin DB wrapper.

Money is integer minor units; a charge is a NEGATIVE `amount_minor`, and a
candidate reports the POSITIVE magnitude (the subscription cost). Recurrence
keys on the provider `merchant` (Track W's captured column), never the noisy
free-text description.
"""

import statistics
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date

from pecunia import period

# Amount cluster tolerance: an occurrence counts toward a merchant's recurring
# charge when its magnitude is within ±10% of the group's representative
# amount — absorbs small price bumps / fx drift without merging genuinely
# different charges from the same merchant.
_AMOUNT_TOLERANCE = 0.10

# Cadence buckets keyed on the MEDIAN gap (days) between consecutive charges.
# (low, high, frequency) — inclusive bounds, non-overlapping, generous enough
# to absorb weekend/holiday posting drift.
_CADENCE_BUCKETS = [
    (5, 9, "weekly"),
    (23, 37, "monthly"),
    (76, 106, "quarterly"),
    (335, 395, "yearly"),
]

# Every individual gap must also fall in the SAME bucket as the median — this
# rejects an irregular set (e.g. one 16-day and one 45-day gap) whose median
# would otherwise masquerade as monthly.


@dataclass(frozen=True)
class DetectTxn:
    merchant: str
    currency: str
    amount_minor: int  # signed; a charge is negative
    occurred_on: date
    category_id: uuid.UUID | None


@dataclass(frozen=True)
class ExistingSub:
    name: str
    currency: str
    amount_minor: int  # positive magnitude
    billing_frequency: str


@dataclass(frozen=True)
class SubscriptionCandidate:
    merchant: str
    suggested_name: str
    amount_minor: int  # positive magnitude
    currency: str
    billing_frequency: str
    occurrences: int
    first_seen: date
    last_seen: date
    suggested_next_renewal: date
    suggested_category_id: uuid.UUID | None


def _representative_amount(magnitudes: list[int]) -> int:
    """The group's modal magnitude; ties fall back to the (rounded) median so a
    two-charge group with two different amounts still yields a stable center."""
    counts = Counter(magnitudes)
    top = max(counts.values())
    modal = [amt for amt, n in counts.items() if n == top]
    if len(modal) == 1:
        return modal[0]
    return round(statistics.median(magnitudes))


def _bucket_for(gap_days: int) -> str | None:
    for low, high, freq in _CADENCE_BUCKETS:
        if low <= gap_days <= high:
            return freq
    return None


def _infer_frequency(days: list[date]) -> str | None:
    """Infer a cadence from sorted occurrence dates, or None when the spacing
    isn't a recognizable regular cycle. Requires the median gap to land in a
    bucket AND every individual gap to share that bucket."""
    if len(days) < 2:
        return None
    ordered = sorted(days)
    gaps = [(b - a).days for a, b in zip(ordered, ordered[1:])]
    median_gap = statistics.median(gaps)
    freq = _bucket_for(round(median_gap))
    if freq is None:
        return None
    if all(_bucket_for(g) == freq for g in gaps):
        return freq
    return None


def _matches_existing(cand_merchant: str, cand_amount: int, cand_currency: str,
                      cand_freq: str, existing: list[ExistingSub]) -> bool:
    for sub in existing:
        if sub.currency != cand_currency or sub.billing_frequency != cand_freq:
            continue
        if sub.name.casefold() != cand_merchant.casefold():
            continue
        if abs(sub.amount_minor - cand_amount) <= round(cand_amount * _AMOUNT_TOLERANCE):
            return True
    return False


def detect_candidates(
    txns: list[DetectTxn], *, today: date, existing: list[ExistingSub]
) -> list[SubscriptionCandidate]:
    groups: dict[tuple[str, str], list[DetectTxn]] = defaultdict(list)
    for t in txns:
        if t.amount_minor >= 0 or not t.merchant:
            continue  # only expenses with a merchant
        groups[(t.merchant, t.currency)].append(t)

    candidates: list[SubscriptionCandidate] = []
    for (merchant, currency), rows in groups.items():
        representative = _representative_amount([abs(r.amount_minor) for r in rows])
        tol = round(representative * _AMOUNT_TOLERANCE)
        kept = [r for r in rows if abs(abs(r.amount_minor) - representative) <= tol]
        if len(kept) < 2:
            continue
        freq = _infer_frequency([r.occurred_on for r in kept])
        if freq is None:
            continue
        if _matches_existing(merchant, representative, currency, freq, existing):
            continue
        kept_sorted = sorted(kept, key=lambda r: r.occurred_on)
        first_seen = kept_sorted[0].occurred_on
        last_seen = kept_sorted[-1].occurred_on
        cat_counts = Counter(r.category_id for r in kept if r.category_id is not None)
        suggested_category_id = cat_counts.most_common(1)[0][0] if cat_counts else None
        candidates.append(
            SubscriptionCandidate(
                merchant=merchant,
                suggested_name=merchant,
                amount_minor=representative,
                currency=currency,
                billing_frequency=freq,
                occurrences=len(kept),
                first_seen=first_seen,
                last_seen=last_seen,
                suggested_next_renewal=period.advance(last_seen, freq),
                suggested_category_id=suggested_category_id,
            )
        )
    candidates.sort(key=lambda c: c.amount_minor, reverse=True)
    return candidates
```

- [ ] **Step 4: Run the pure tests**

Run: `cd api && uv run pytest tests/services/test_subscription_detect.py -v`
Expected: PASS (all cases).

- [ ] **Step 5: Add the DB wrapper**

Append to `subscription_detect.py`:

```python
import sqlalchemy as sa  # noqa: E402  (grouped here to keep the pure core import-light)
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from pecunia.models.subscription import Subscription, SubscriptionStatus  # noqa: E402
from pecunia.models.transaction import Transaction  # noqa: E402
from pecunia.services.scoping import scoped_select  # noqa: E402


class SubscriptionDetector:
    """Reads a workspace's imported expenses and proposes recurring-charge
    candidates. Read-only — writes nothing. Clock-free (`today` passed in)."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def suggest(
        self, workspace_id: uuid.UUID, *, today: date
    ) -> list[SubscriptionCandidate]:
        stmt = scoped_select(Transaction, workspace_id).where(
            Transaction.external_id.is_not(None),   # imported only
            Transaction.amount_minor < 0,           # expenses
            Transaction.transfer_id.is_(None),      # not a transfer leg
            Transaction.deleted_at.is_(None),       # not tombstoned
            Transaction.merchant.is_not(None),      # has a merchant to key on
        )
        rows = (await self.db.execute(stmt)).scalars().all()
        txns = [
            DetectTxn(
                merchant=r.merchant,
                currency=r.currency,
                amount_minor=r.amount_minor,
                occurred_on=r.occurred_on,
                category_id=r.category_id,
            )
            for r in rows
        ]
        sub_rows = (
            await self.db.execute(
                scoped_select(Subscription, workspace_id).where(
                    Subscription.status == SubscriptionStatus.ACTIVE.value
                )
            )
        ).scalars().all()
        existing = [
            ExistingSub(
                name=s.name, currency=s.currency,
                amount_minor=s.amount_minor, billing_frequency=s.billing_frequency,
            )
            for s in sub_rows
        ]
        return detect_candidates(txns, today=today, existing=existing)
```

> `scoped_select` returns a workspace-scoped `select`; confirm its import path matches `services/subscriptions.py` (`from pecunia.services.scoping import ... scoped_select`). Check `Transaction.transfer_id`/`deleted_at`/`external_id` are the real column names (they are — see the model).

- [ ] **Step 6: Add the endpoint + schema**

In `api/src/pecunia/api/subscriptions.py`:
- import at top: `from pecunia.services.subscription_detect import SubscriptionDetector`
- add the Out model near `SubscriptionOut`:

```python
class SubscriptionSuggestionOut(BaseModel):
    merchant: str
    suggested_name: str
    amount_minor: int
    currency: str
    billing_frequency: str
    occurrences: int
    first_seen: date
    last_seen: date
    suggested_next_renewal: date
    suggested_category_id: uuid.UUID | None
```

- add the route IMMEDIATELY after `subscription_totals` (so it is declared before `/{subscription_id}` — the same route-ordering reason):

```python
# Declared before `/{subscription_id}` so "suggestions" is matched as this
# route rather than parsed as a subscription id.
@router.get("/suggestions")
async def subscription_suggestions(
    db: Annotated[AsyncSession, Depends(get_db)],
    wsctx: Annotated[WorkspaceContext, Depends(require_workspace)],
) -> list[SubscriptionSuggestionOut]:
    detector = SubscriptionDetector(db)
    candidates = await detector.suggest(wsctx.workspace_id, today=date.today())
    return [
        SubscriptionSuggestionOut(
            merchant=c.merchant,
            suggested_name=c.suggested_name,
            amount_minor=c.amount_minor,
            currency=c.currency,
            billing_frequency=c.billing_frequency,
            occurrences=c.occurrences,
            first_seen=c.first_seen,
            last_seen=c.last_seen,
            suggested_next_renewal=c.suggested_next_renewal,
            suggested_category_id=c.suggested_category_id,
        )
        for c in candidates
    ]
```

(`date` is already imported in this module.)

- [ ] **Step 7: Write the endpoint test**

Create `api/tests/api/test_subscription_suggestions.py`. Follow the existing subscriptions-API test setup (find it: `grep -rl "subscriptions/totals\|/subscriptions" api/tests/api`). Seed a linked account + three monthly imported `Netflix` transactions (`external_id` set, `merchant="Netflix"`, `amount_minor=-1990`, dates a month apart, `status` POSTED — i.e. create them via `TransactionService.create(..., external_id=..., merchant=...)`), then `GET /subscriptions/suggestions` and assert one candidate with `merchant == "Netflix"`, `amount_minor == 1990`, `billing_frequency == "monthly"`. Add one assertion that an already-created active `Netflix`/BRL/1990/monthly subscription suppresses the candidate.

- [ ] **Step 8: Run all Task-4 tests**

Run: `cd api && uv run pytest tests/services/test_subscription_detect.py tests/api/test_subscription_suggestions.py -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd api && git add src/pecunia/services/subscription_detect.py src/pecunia/api/subscriptions.py tests/services/test_subscription_detect.py tests/api/test_subscription_suggestions.py
git commit -m "feat(api): detect recurring charges and suggest subscriptions"
```

---

### Task 5: By-category subscription totals

**Files:**
- Modify: `api/src/pecunia/services/subscriptions.py:350-369` (`totals`)
- Modify: `api/src/pecunia/api/subscriptions.py` (`CurrencyTotal` + new `CategorySubtotal`)
- Test: existing subscriptions-totals test + new `api/tests/api/test_subscription_totals_by_category.py`

**Interfaces:**
- Consumes: `annual_minor`/`monthly_minor` (existing), `Category` (for names).
- Produces: each `totals` currency bucket gains `by_category: list[{category_id, name, monthly_minor, annual_minor, count}]`; `CurrencyTotal` gains `by_category: list[CategorySubtotal]`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/api/test_subscription_totals_by_category.py` (follow the existing totals test's setup). Seed, in one currency: two monthly subs in category A (e.g. 1000 + 2000) and one yearly sub with no category (e.g. 12000/yr → 1000/mo). Assert:

```python
    body = resp.json()["BRL"]
    assert body["monthly_minor"] == 1000 + 2000 + 1000      # existing rollup unchanged
    cats = {c["name"]: c for c in body["by_category"]}
    assert cats["A"]["monthly_minor"] == 3000
    assert cats["A"]["count"] == 2
    uncategorized = next(c for c in body["by_category"] if c["category_id"] is None)
    assert uncategorized["name"] is None
    assert uncategorized["monthly_minor"] == 1000
    assert uncategorized["annual_minor"] == 12000
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && uv run pytest tests/api/test_subscription_totals_by_category.py -v`
Expected: FAIL — response has no `by_category` key.

- [ ] **Step 3: Extend the service**

Replace `SubscriptionService.totals` body so each currency bucket also carries a per-category breakdown. Needs category names, so load the workspace's categories into an id→name map first:

```python
    async def totals(
        self, workspace_id: uuid.UUID, *, status: str = SubscriptionStatus.ACTIVE.value
    ) -> dict[str, dict]:
        """Σ of the normalized monthly + annual cost of every subscription with
        `status`, bucketed per currency: `{currency: {monthly_minor,
        annual_minor, count, by_category}}`. `by_category` splits the same
        figures per category (category_id None = uncategorized bucket, name
        None). Money is never summed across currencies (§4)."""
        stmt = scoped_select(Subscription, workspace_id).where(
            Subscription.status == status
        )
        rows = (await self.db.execute(stmt)).scalars().all()

        cat_rows = (
            await self.db.execute(scoped_select(Category, workspace_id))
        ).scalars().all()
        name_by_id = {c.id: c.name for c in cat_rows}

        out: dict[str, dict] = {}
        # (currency, category_id) -> accumulator, so each currency's by_category
        # is built alongside its rollup in one pass.
        per_cat: dict[str, dict[uuid.UUID | None, dict]] = {}
        for sub in rows:
            m = monthly_minor(sub.amount_minor, sub.billing_frequency)
            a = annual_minor(sub.amount_minor, sub.billing_frequency)
            bucket = out.setdefault(
                sub.currency, {"monthly_minor": 0, "annual_minor": 0, "count": 0, "by_category": []}
            )
            bucket["monthly_minor"] += m
            bucket["annual_minor"] += a
            bucket["count"] += 1
            cat_bucket = per_cat.setdefault(sub.currency, {}).setdefault(
                sub.category_id,
                {"category_id": sub.category_id, "name": None, "monthly_minor": 0, "annual_minor": 0, "count": 0},
            )
            cat_bucket["name"] = name_by_id.get(sub.category_id) if sub.category_id is not None else None
            cat_bucket["monthly_minor"] += m
            cat_bucket["annual_minor"] += a
            cat_bucket["count"] += 1
        for currency, bucket in out.items():
            # Largest category first; uncategorized sorts by the same key.
            bucket["by_category"] = sorted(
                per_cat.get(currency, {}).values(),
                key=lambda c: c["monthly_minor"],
                reverse=True,
            )
        return out
```

Add `from pecunia.models.category import Category` — it is already imported at the top of `subscriptions.py` (line 14). Confirm.

- [ ] **Step 4: Extend the API schema**

In `api/subscriptions.py`, add above `CurrencyTotal`:

```python
class CategorySubtotal(BaseModel):
    category_id: uuid.UUID | None
    name: str | None
    monthly_minor: int
    annual_minor: int
    count: int
```

and extend `CurrencyTotal`:

```python
class CurrencyTotal(BaseModel):
    monthly_minor: int
    annual_minor: int
    count: int
    by_category: list[CategorySubtotal]
```

(The `subscription_totals` route already returns `await svc.totals(...)`; FastAPI coerces the dict into `dict[str, CurrencyTotal]`. No route-body change needed.)

- [ ] **Step 5: Run the test + existing totals test**

Run: `cd api && uv run pytest tests/api/test_subscription_totals_by_category.py -v && uv run pytest -k "totals and subscription" -v`
Expected: PASS (new + existing totals tests; the existing ones still pass because the rollup fields are unchanged).

- [ ] **Step 6: Commit**

```bash
cd api && git add src/pecunia/services/subscriptions.py src/pecunia/api/subscriptions.py tests/api/test_subscription_totals_by_category.py
git commit -m "feat(api): break subscription totals down by category"
```

---

### Task 6: Suggestions UI on the Subscriptions screen

**Files:**
- Modify: `web/src/features/subscriptions/useSubscriptions.ts` (type + hook; extend `CurrencyTotal`)
- Modify: `web/src/features/subscriptions/SubscriptionForm.tsx` (create-mode prefill)
- Create: `web/src/features/subscriptions/SubscriptionSuggestions.tsx` + `.test.tsx`
- Modify: `web/src/features/subscriptions/SubscriptionsScreen.tsx` (mount + wire)

**Interfaces:**
- Consumes: `GET /subscriptions/suggestions` (Task 4).
- Produces: `SubscriptionSuggestion` type; `useSubscriptionSuggestions()`; `SubscriptionFormInitial` + `SubscriptionForm`'s `initialValues` prop; `SubscriptionSuggestions` component (props: `suggestions`, `categoryNameById`, `onAdd`, `onIgnore`).

- [ ] **Step 1: Add the hook + type (and extend totals type)**

In `useSubscriptions.ts`:
- Add the type near `SubscriptionOut`:

```ts
/** Mirrors `SubscriptionSuggestionOut` (`api/src/pecunia/api/subscriptions.py`):
 * a detected recurring-charge candidate the user can confirm into a real
 * subscription. Read-only; carries no id (it is not persisted). */
export interface SubscriptionSuggestion {
  merchant: string;
  suggested_name: string;
  amount_minor: number;
  currency: string;
  billing_frequency: BillingFrequency;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  suggested_next_renewal: string;
  suggested_category_id: string | null;
}
```

- Extend `CurrencyTotal` and add a `CategorySubtotal`:

```ts
export interface CategorySubtotal {
  category_id: string | null;
  name: string | null;
  monthly_minor: number;
  annual_minor: number;
  count: number;
}

export interface CurrencyTotal {
  monthly_minor: number;
  annual_minor: number;
  count: number;
  by_category: CategorySubtotal[];
}
```

- Add the query hook near `useSubscriptionTotals`:

```ts
/** Detected recurring-charge candidates (`GET /subscriptions/suggestions`,
 * Track W). Keyed `[...qk.subscriptions, "suggestions"]` so it nests under the
 * `qk.subscriptions` prefix every mutation already invalidates — confirming a
 * candidate (a create) therefore refreshes this list and the candidate drops
 * out (its merchant now matches an active subscription). */
export function useSubscriptionSuggestions() {
  return useQuery({
    queryKey: [...qk.subscriptions, "suggestions"],
    queryFn: () => apiFetch<SubscriptionSuggestion[]>("/subscriptions/suggestions"),
  });
}
```

- [ ] **Step 2: Add create-mode prefill to `SubscriptionForm`**

In `SubscriptionForm.tsx`:
- export an initial-values type and accept it:

```ts
/** Create-mode seed values (Track W: pre-filling the form from a detected
 * candidate). Ignored in edit mode (the subscription's own values win). */
export interface SubscriptionFormInitial {
  name?: string;
  amount_minor?: number;
  currency?: string;
  billing_frequency?: BillingFrequency;
  next_renewal?: string;
  category_id?: string | null;
}
```

- add `initialValues?: SubscriptionFormInitial;` to `SubscriptionFormProps`.
- seed the create-mode `useState` defaults from `initialValues` (edit mode still uses `subscription`). Change the initializers:

```ts
  const [name, setName] = useState(subscription?.name ?? initialValues?.name ?? "");
  const [currency, setCurrency] = useState(
    subscription?.currency ??
      (initialValues?.currency && CURRENCY_CODES.includes(initialValues.currency)
        ? initialValues.currency
        : defaultCurrency && CURRENCY_CODES.includes(defaultCurrency)
          ? defaultCurrency
          : CURRENCY_CODES[0]),
  );
  const [amount, setAmount] = useState(
    subscription
      ? minorToAmountInput(subscription.amount_minor, subscription.currency)
      : initialValues?.amount_minor != null && initialValues?.currency
        ? minorToAmountInput(initialValues.amount_minor, initialValues.currency)
        : "",
  );
  const [frequency, setFrequency] = useState<BillingFrequency>(
    subscription?.billing_frequency ?? initialValues?.billing_frequency ?? "monthly",
  );
  const [nextRenewal, setNextRenewal] = useState(
    subscription?.next_renewal ?? initialValues?.next_renewal ?? "",
  );
  const [categoryId, setCategoryId] = useState(
    subscription?.category_id ?? initialValues?.category_id ?? "",
  );
```

(Leave `logo`, `startedOn`, `contactId`, `accountId`, `status` initializers unchanged.)

- [ ] **Step 3: Write the failing `SubscriptionSuggestions` test**

Create `web/src/features/subscriptions/SubscriptionSuggestions.test.tsx`. Follow the co-located test idiom in this folder (read `SubscriptionsScreen.test.tsx` for the render/provider helpers). Assert: given two suggestions, both merchants render; clicking "Add" on one calls `onAdd` with that suggestion; clicking "Ignore" calls `onIgnore` with that suggestion's merchant; rendering with `[]` renders nothing (the section is hidden). Example core:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SubscriptionSuggestions from "./SubscriptionSuggestions";
import type { SubscriptionSuggestion } from "./useSubscriptions";

const base: SubscriptionSuggestion = {
  merchant: "Netflix", suggested_name: "Netflix", amount_minor: 1990, currency: "BRL",
  billing_frequency: "monthly", occurrences: 3, first_seen: "2026-07-05",
  last_seen: "2026-09-05", suggested_next_renewal: "2026-10-05", suggested_category_id: null,
};

describe("SubscriptionSuggestions", () => {
  it("renders nothing when there are no suggestions", () => {
    const { container } = render(
      <SubscriptionSuggestions suggestions={[]} categoryNameById={{}} onAdd={vi.fn()} onIgnore={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("fires onAdd and onIgnore", () => {
    const onAdd = vi.fn();
    const onIgnore = vi.fn();
    render(
      <SubscriptionSuggestions
        suggestions={[base, { ...base, merchant: "Spotify", suggested_name: "Spotify" }]}
        categoryNameById={{}}
        onAdd={onAdd}
        onIgnore={onIgnore}
      />,
    );
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /add/i })[0]);
    expect(onAdd).toHaveBeenCalledWith(base);
    fireEvent.click(screen.getAllByRole("button", { name: /ignore/i })[0]);
    expect(onIgnore).toHaveBeenCalledWith("Netflix");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd web && npx vitest run src/features/subscriptions/SubscriptionSuggestions.test.tsx`
Expected: FAIL — module `./SubscriptionSuggestions` not found.

- [ ] **Step 5: Implement `SubscriptionSuggestions`**

Create `web/src/features/subscriptions/SubscriptionSuggestions.tsx`. Presentational — the screen owns the query, the ignore set, and the Add→form wiring. Tokens only, English copy, `MoneyText`/`DateText`. Use `Card`, `Button` from the same ui kit the screen uses.

```tsx
import Button from "../../components/ui/Button";
import Card from "../../components/ui/Card";
import { DateText, MoneyText } from "../../lib/preferences";
import type { BillingFrequency, SubscriptionSuggestion } from "./useSubscriptions";

const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  weekly: "weekly",
  monthly: "monthly",
  quarterly: "quarterly",
  yearly: "yearly",
};

export interface SubscriptionSuggestionsProps {
  suggestions: SubscriptionSuggestion[];
  /** category id → display name, for the suggested-category hint. */
  categoryNameById: Record<string, string>;
  onAdd: (suggestion: SubscriptionSuggestion) => void;
  onIgnore: (merchant: string) => void;
}

/**
 * The detected recurring-charge review strip (Track W), shown above the
 * subscription list. Each candidate was found in the imported bank/card
 * transactions (merchant + ~equal amount + a regular cadence); "Add" opens
 * the normal create form pre-filled so the user confirms/edits before it
 * becomes a real subscription, and "Ignore" dismisses it for the session.
 * Renders nothing when there are no candidates.
 */
function SubscriptionSuggestions({ suggestions, categoryNameById, onAdd, onIgnore }: SubscriptionSuggestionsProps) {
  if (suggestions.length === 0) {
    return null;
  }
  return (
    <Card>
      <h2 className="font-display text-lg text-ink">
        {suggestions.length === 1
          ? "We found 1 possible subscription"
          : `We found ${suggestions.length} possible subscriptions`}
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        Recurring charges spotted in your imported transactions. Add the ones you want to track.
      </p>
      <ul className="mt-4 divide-y divide-hairline">
        {suggestions.map((s) => {
          const categoryName = s.suggested_category_id
            ? categoryNameById[s.suggested_category_id]
            : undefined;
          return (
            <li
              key={`${s.merchant}:${s.currency}`}
              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm text-ink">{s.merchant}</span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-ink-2">
                  <MoneyText minor={s.amount_minor} currency={s.currency} />
                  <span className="text-ink-faint">· {FREQUENCY_LABELS[s.billing_frequency]}</span>
                  <span className="text-ink-faint">· seen {s.occurrences}×</span>
                  <span className="text-ink-faint">· since</span>
                  <DateText iso={s.first_seen} />
                  {categoryName ? <span className="text-ink-faint">· {categoryName}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" onClick={() => onAdd(s)}>
                  Add
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onIgnore(s.merchant)}>
                  Ignore
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default SubscriptionSuggestions;
```

> Verify `MoneyText`/`DateText` import from `../../lib/preferences` (the screen does) and that `Button` supports `size="sm"`/`variant="ghost"` (the screen uses both). If `Card`'s import path differs, match the screen's import.

- [ ] **Step 6: Run to verify it passes**

Run: `cd web && npx vitest run src/features/subscriptions/SubscriptionSuggestions.test.tsx`
Expected: PASS.

- [ ] **Step 7: Wire it into `SubscriptionsScreen`**

In `SubscriptionsScreen.tsx`:
- extend `FormState`: `{ mode: "create"; initial?: SubscriptionFormInitial } | { mode: "edit"; subscription: SubscriptionOut }`.
- import `SubscriptionSuggestions`, `useSubscriptionSuggestions`, and the `SubscriptionFormInitial` type; import `useState` already present.
- add state + query:

```tsx
  const suggestionsQuery = useSubscriptionSuggestions();
  const [ignoredMerchants, setIgnoredMerchants] = useState<Set<string>>(new Set());
  const suggestions = (suggestionsQuery.data ?? []).filter((s) => !ignoredMerchants.has(s.merchant));
  const categoryNameById = Object.fromEntries(categories.map((c) => [c.id, c.name]));

  function handleAddSuggestion(s: SubscriptionSuggestion) {
    setFormState({
      mode: "create",
      initial: {
        name: s.suggested_name,
        amount_minor: s.amount_minor,
        currency: s.currency,
        billing_frequency: s.billing_frequency,
        next_renewal: s.suggested_next_renewal,
        category_id: s.suggested_category_id,
      },
    });
  }

  function handleIgnoreSuggestion(merchant: string) {
    setIgnoredMerchants((prev) => new Set(prev).add(merchant));
  }
```

- render the section just below the `SummaryHeader` and above the form panel:

```tsx
      <SubscriptionSuggestions
        suggestions={suggestions}
        categoryNameById={categoryNameById}
        onAdd={handleAddSuggestion}
        onIgnore={handleIgnoreSuggestion}
      />
```

- pass the prefill into the create-mode form (where `<SubscriptionForm .../>` is rendered):

```tsx
            <SubscriptionForm
              subscription={formState.mode === "edit" ? formState.subscription : undefined}
              initialValues={formState.mode === "create" ? formState.initial : undefined}
              defaultCurrency={baseCurrency}
              onCancel={() => setFormState(null)}
              onSuccess={() => { /* unchanged */ }}
            />
```

Import `SubscriptionSuggestion`/`SubscriptionFormInitial` types where the other type imports are. Keep the New-subscription button's `setFormState({ mode: "create" })` working (no `initial` → undefined prefill).

- [ ] **Step 8: Run the screen test + full web suite**

Run: `cd web && npx vitest run src/features/subscriptions/`
Expected: PASS (existing screen test still green — the section renders nothing until suggestions load; if the screen test mocks `apiFetch`, add a `/subscriptions/suggestions` → `[]` stub so the new query resolves empty).

- [ ] **Step 9: Commit**

```bash
cd web && git add src/features/subscriptions/useSubscriptions.ts src/features/subscriptions/SubscriptionForm.tsx src/features/subscriptions/SubscriptionSuggestions.tsx src/features/subscriptions/SubscriptionSuggestions.test.tsx src/features/subscriptions/SubscriptionsScreen.tsx
git commit -m "feat(web): show detected subscription suggestions for confirmation"
```

---

### Task 7: By-category breakdown in the Subscriptions header

**Files:**
- Modify: `web/src/features/subscriptions/SubscriptionsScreen.tsx` (render the base-currency `by_category` under the rollup)
- Test: extend `web/src/features/subscriptions/SubscriptionsScreen.test.tsx`

**Interfaces:**
- Consumes: `CurrencyTotal.by_category` (Task 5, Task 6 type).

- [ ] **Step 1: Write the failing test**

In `SubscriptionsScreen.test.tsx`, extend the totals mock so the base-currency bucket includes a `by_category` array (e.g. `[{category_id:"c1",name:"Streaming",monthly_minor:3000,annual_minor:36000,count:2},{category_id:null,name:null,monthly_minor:1000,annual_minor:12000,count:1}]`) and assert the breakdown renders both "Streaming" and an "Uncategorized" label with their monthly figures. Match how the existing test mocks `useSubscriptionTotals`/`apiFetch`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/features/subscriptions/SubscriptionsScreen.test.tsx`
Expected: FAIL — category rows not found.

- [ ] **Step 3: Render the breakdown**

In `SubscriptionsScreen.tsx`, below `<SummaryHeader stats={rollupStats} />`, render the base-currency category breakdown when present:

```tsx
      {subscriptions.length > 0 && baseTotal.by_category && baseTotal.by_category.length > 0 ? (
        <Card>
          <h2 className="font-display text-sm text-ink-2">Monthly spend by category</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {baseTotal.by_category.map((row) => (
              <li
                key={row.category_id ?? "uncategorized"}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="truncate text-ink">{row.name ?? "Uncategorized"}</span>
                <span className="font-mono text-xs text-ink-2">
                  <MoneyText minor={row.monthly_minor} currency={baseCurrency} />
                  <span className="text-ink-faint"> / mo</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
```

Update the `baseTotal` fallback so it includes `by_category: []`:

```tsx
  const baseTotal = totals[baseCurrency] ?? { monthly_minor: 0, annual_minor: 0, count: 0, by_category: [] };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/features/subscriptions/SubscriptionsScreen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full build + lint + test**

Run: `cd web && npm run build && npm run lint && npm run test`
Expected: PASS, 0 new warnings.

- [ ] **Step 6: Commit**

```bash
cd web && git add src/features/subscriptions/SubscriptionsScreen.tsx src/features/subscriptions/SubscriptionsScreen.test.tsx
git commit -m "feat(web): break down subscription spend by category in the header"
```

---

## W-2 (operational, after merge + deploy — NOT a code task)

The ~380 already-imported rows have `merchant = NULL`. After deploying, run a one-time backfill on the VM (same pattern as the 3-month backfill in the session scratchpad). The script, for each `BankAccountLink`, re-fetches the provider transactions and fills the merchant on existing rows only:

```python
# backfill_merchant.py — run inside the api container on the VM.
import asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker
from pecunia.config import get_settings
from pecunia.db import init_engine
from pecunia.models import BankAccountLink, Transaction, Workspace
from pecunia.services.banksync.provider import PluggyProvider

async def main() -> None:
    settings = get_settings()
    engine = init_engine()
    sm = async_sessionmaker(engine)
    provider = PluggyProvider(settings.pluggy_client_id, settings.pluggy_client_secret)
    async with sm() as db:
        links = (await db.execute(sa.select(BankAccountLink))).scalars().all()
        filled = 0
        for link in links:
            # sync_from floor keeps the fetch bounded; map external_id -> merchant.
            rows = await provider.fetch_transactions(link.pluggy_account_id, from_date=link.sync_from)
            by_ext = {r.external_id: r.merchant for r in rows if r.merchant}
            if not by_ext:
                continue
            existing = (await db.execute(
                sa.select(Transaction).where(
                    Transaction.account_id == link.account_id,
                    Transaction.external_id.in_(list(by_ext)),
                    Transaction.merchant.is_(None),
                )
            )).scalars().all()
            for tx in existing:
                tx.merchant = by_ext.get(tx.external_id)
                if tx.merchant is not None:
                    filled += 1
        await db.commit()
        print(f"backfilled merchant on {filled} rows")
    await provider.aclose()
    await engine.dispose()

asyncio.run(main())
```

Only fills nulls (`merchant IS NULL`), only on imported rows (matched by `external_id`), never touches manual rows. Verify with `SELECT count(*) FROM transactions WHERE merchant IS NOT NULL;` before/after, then re-check `GET /subscriptions/suggestions` returns real candidates.

---

## Self-Review

**Spec coverage:**
- W-1 merchant capture → Tasks 1-3. ✓
- W-2 backfill → operational section (spec explicitly says "not a code deliverable"). ✓
- W-3 detector + `/suggestions` → Task 4. ✓
- W-4 by-category totals → Task 5. ✓
- W-5 suggestions UI + by-category header → Tasks 6-7. ✓

**Type consistency:** `SubscriptionCandidate`/`SubscriptionSuggestionOut`/`SubscriptionSuggestion` carry identical fields across service→API→web. `CurrencyTotal.by_category: list[CategorySubtotal]` matches the service dict keys (`category_id,name,monthly_minor,annual_minor,count`). `detect_candidates`/`SubscriptionDetector.suggest` signatures match their call sites and tests. `TransactionService.create(..., merchant=None)` matches `_sync_link`'s `merchant=row.merchant` and `ProviderTransaction.merchant`.

**Placeholder scan:** every code step shows the code; test steps show assertions; every "find it" note points the implementer at an exact `grep` rather than leaving a gap. No TBD/TODO.
