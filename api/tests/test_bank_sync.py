"""Task 4 (Track T): `BankSyncService` — links a Pluggy provider account to a
Pecunia account (existing or newly created), imports its transaction history,
anchors the account's initial balance so the derived balance matches the
provider's reported balance, and re-syncs on a schedule (dedup by
external_id, tombstone-aware, per-connection error isolation). Always uses
`FakeBankProvider` — no real network call in this suite."""

import uuid
from datetime import UTC, date, datetime, timedelta

import sqlalchemy as sa

from pecunia.audit.actions import Actions
from pecunia.models import (
    Account,
    AuditEvent,
    BankAccountLink,
    BankCategoryMapping,
    BankConnection,
    Category,
    Transaction,
)
from pecunia.services.accounts import AccountService
from pecunia.services.banksync.provider import (
    FakeBankProvider,
    ProviderAccount,
    ProviderConnection,
    ProviderTransaction,
)
from pecunia.services.banksync.sync import (
    SYNC_OVERLAP_DAYS,
    AccountAlreadyLinkedError,
    BankSyncService,
    PluggyAccountAlreadyLinkedError,
    PluggyAccountNotFoundError,
)
from pecunia.services.transactions import AccountNotFoundError, CategoryNotFoundError, CurrencyMismatchError

TODAY = date(2026, 9, 30)


# --------------------------------------------------------------------------- #
# fixtures / helpers
# --------------------------------------------------------------------------- #


def _bank_account(pluggy_account_id="acc-1", item_id="item-1", *, type="BANK", subtype="CHECKING_ACCOUNT",
                   name="Checking", balance_minor=50_000_00, currency="BRL", credit_limit_minor=None,
                   bill_close_date=None, bill_due_date=None, number="0001"):
    return ProviderAccount(
        pluggy_account_id=pluggy_account_id,
        item_id=item_id,
        type=type,
        subtype=subtype,
        name=name,
        number=number,
        balance_minor=balance_minor,
        currency=currency,
        credit_limit_minor=credit_limit_minor,
        bill_close_date=bill_close_date,
        bill_due_date=bill_due_date,
    )


def _tx_row(external_id, *, days_ago=1, amount_minor=-100_00, currency="BRL", status="POSTED",
            category=None, description="Purchase"):
    return ProviderTransaction(
        external_id=external_id,
        date=TODAY - timedelta(days=days_ago),
        description=description,
        amount_minor=amount_minor,
        currency=currency,
        status=status,
        pluggy_category=category,
    )


async def _account(db, ws_id, *, currency="BRL", initial_balance_minor=0, type="checking", name="Manual"):
    account = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type=type, currency=currency,
        initial_balance_minor=initial_balance_minor,
    )
    db.add(account)
    await db.flush()
    return account


async def _category(db, ws_id, *, name="Food", kind="expense"):
    category = Category(id=uuid.uuid4(), workspace_id=ws_id, name=name, kind=kind, color="#000000")
    db.add(category)
    await db.flush()
    return category


async def _connection(db, ws_id, *, pluggy_item_id="item-1", institution_name="Bank",
                       status="ok", last_synced_at=None):
    connection = BankConnection(
        id=uuid.uuid4(), workspace_id=ws_id, pluggy_item_id=pluggy_item_id,
        institution_name=institution_name, status=status, last_synced_at=last_synced_at,
    )
    db.add(connection)
    await db.flush()
    return connection


async def _link(db, ws_id, connection, account, *, pluggy_account_id="acc-1", sync_from=date(2026, 1, 1),
                 provider_balance_minor=None, credit_limit_minor=None, bill_close_date=None, bill_due_date=None):
    link = BankAccountLink(
        id=uuid.uuid4(), workspace_id=ws_id, connection_id=connection.id, account_id=account.id,
        pluggy_account_id=pluggy_account_id, sync_from=sync_from,
        provider_balance_minor=provider_balance_minor, credit_limit_minor=credit_limit_minor,
        bill_close_date=bill_close_date, bill_due_date=bill_due_date,
    )
    db.add(link)
    await db.flush()
    return link


async def _actions(db) -> list[str]:
    return (await db.execute(sa.select(AuditEvent.action))).scalars().all()


def _capture_sql(engine, statements: list[str]):
    """Registers a `before_cursor_execute` listener on `engine`'s underlying
    sync engine that appends every statement string sent to the DB driver
    into `statements`. Returns the listener so the caller can remove it —
    used to assert a row lock (`FOR UPDATE`) was actually taken, not just
    that behavior happens to look race-safe (finding 3)."""

    def _listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    sa.event.listen(engine.sync_engine, "before_cursor_execute", _listener)
    return _listener


# --------------------------------------------------------------------------- #
# link_account
# --------------------------------------------------------------------------- #


async def test_link_to_existing_account_raises_on_currency_mismatch(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="USD")
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL")]},
    )
    svc = BankSyncService(db, provider)
    try:
        await svc.link_account(
            ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
            sync_from=date(2026, 1, 1), today=TODAY, account_id=account.id,
        )
        raise AssertionError("expected CurrencyMismatchError")
    except CurrencyMismatchError:
        pass


async def test_link_to_existing_account_succeeds_and_emits_linked_event(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=0)
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
    )
    svc = BankSyncService(db, provider)
    link = await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1), today=TODAY, account_id=account.id,
    )
    await db.commit()
    assert link.account_id == account.id
    assert link.pluggy_account_id == "acc-1"
    actions = await _actions(db)
    assert Actions.BANK_ACCOUNT_LINKED in actions
    assert Actions.BANK_CONNECTION_CREATED in actions


async def test_link_creates_account_with_derived_type_currency_name(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                _bank_account(
                    pluggy_account_id="acc-savings", type="BANK", subtype="SAVINGS_ACCOUNT",
                    name="Poupança", currency="BRL", balance_minor=0,
                )
            ]
        },
    )
    svc = BankSyncService(db, provider)
    link = await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-savings",
        sync_from=date(2026, 1, 1), today=TODAY,
    )
    await db.commit()
    account = await db.get(Account, link.account_id)
    assert account.name == "Poupança"
    assert account.type == "savings"
    assert account.currency == "BRL"


async def test_link_creates_account_uses_new_account_name_override(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(type="CREDIT", subtype="CREDIT_CARD", balance_minor=0)]},
    )
    svc = BankSyncService(db, provider)
    link = await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1), today=TODAY, new_account_name="My Card",
    )
    account = await db.get(Account, link.account_id)
    assert account.name == "My Card"
    assert account.type == "credit_card"


async def test_link_unknown_pluggy_account_raises_not_found(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": []},
    )
    svc = BankSyncService(db, provider)
    try:
        await svc.link_account(
            ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-missing",
            sync_from=date(2026, 1, 1), today=TODAY,
        )
        raise AssertionError("expected PluggyAccountNotFoundError")
    except PluggyAccountNotFoundError:
        pass


async def test_link_unknown_item_raises_not_found(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    provider = FakeBankProvider(connections=[], accounts_by_item={})
    svc = BankSyncService(db, provider)
    try:
        await svc.link_account(
            ws_id, pluggy_item_id="item-missing", pluggy_account_id="acc-1",
            sync_from=date(2026, 1, 1), today=TODAY,
        )
        raise AssertionError("expected PluggyAccountNotFoundError")
    except PluggyAccountNotFoundError:
        pass


async def test_link_guards_account_already_linked(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                _bank_account(pluggy_account_id="acc-1", currency="BRL", balance_minor=0),
                _bank_account(pluggy_account_id="acc-2", currency="BRL", balance_minor=0),
            ]
        },
    )
    svc = BankSyncService(db, provider)
    await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1), today=TODAY, account_id=account.id,
    )
    try:
        await svc.link_account(
            ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-2",
            sync_from=date(2026, 1, 1), today=TODAY, account_id=account.id,
        )
        raise AssertionError("expected AccountAlreadyLinkedError")
    except AccountAlreadyLinkedError:
        pass


async def test_link_guards_pluggy_account_already_linked_in_workspace(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account_a = await _account(db, ws_id, currency="BRL", name="A")
    account_b = await _account(db, ws_id, currency="BRL", name="B")
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(pluggy_account_id="acc-1", currency="BRL", balance_minor=0)]},
    )
    svc = BankSyncService(db, provider)
    await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1), today=TODAY, account_id=account_a.id,
    )
    try:
        await svc.link_account(
            ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
            sync_from=date(2026, 1, 1), today=TODAY, account_id=account_b.id,
        )
        raise AssertionError("expected PluggyAccountAlreadyLinkedError")
    except PluggyAccountAlreadyLinkedError:
        pass


async def test_link_account_id_not_found_raises_account_not_found(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
    )
    svc = BankSyncService(db, provider)
    try:
        await svc.link_account(
            ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
            sync_from=date(2026, 1, 1), today=TODAY, account_id=uuid.uuid4(),
        )
        raise AssertionError("expected AccountNotFoundError")
    except AccountNotFoundError:
        pass


async def test_link_account_anchors_initial_balance_after_first_import(db, initialized_instance):
    """provider balance 500.00, one imported tx of -100.00, prior manual
    balance 250.00 => initial_balance_minor adjusted so balance() == 50000."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=250_00)
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=500_00)]},
        transactions_by_account={"acc-1": [_tx_row("tx-1", amount_minor=-100_00)]},
    )
    svc = BankSyncService(db, provider)
    await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1), today=TODAY, account_id=account.id,
    )
    await db.commit()
    balance = await AccountService(db).balance(account)
    assert balance == 500_00
    actions = await _actions(db)
    assert Actions.ACCOUNT_BALANCE_RECONCILED in actions
    assert Actions.TRANSACTION_IMPORTED in actions


async def test_link_account_anchor_step_locks_the_account_row(db, engine, initialized_instance):
    """Finding 3: the anchor's balance()-then-write on the Account row must
    take `SELECT ... FOR UPDATE` — otherwise a racing reconcile()/link_account
    reading the same not-yet-committed balance can double-adjust it."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=250_00)
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=500_00)]},
        transactions_by_account={"acc-1": [_tx_row("tx-1", amount_minor=-100_00)]},
    )
    svc = BankSyncService(db, provider)

    statements: list[str] = []
    listener = _capture_sql(engine, statements)
    try:
        await svc.link_account(
            ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
            sync_from=date(2026, 1, 1), today=TODAY, account_id=account.id,
        )
    finally:
        sa.event.remove(engine.sync_engine, "before_cursor_execute", listener)

    assert any("FOR UPDATE" in s.upper() and "accounts" in s.lower() for s in statements)


async def test_link_account_updates_connection_status_and_last_synced_at(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
    )
    svc = BankSyncService(db, provider)
    link = await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1), today=TODAY, account_id=account.id,
    )
    connection = await db.get(BankConnection, link.connection_id)
    assert connection.status == "ok"
    assert connection.last_synced_at is not None


async def test_link_account_stores_card_fields_and_negative_provider_balance(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                _bank_account(
                    type="CREDIT", subtype="CREDIT_CARD", currency="BRL", balance_minor=-321_00,
                    credit_limit_minor=1_000_00, bill_close_date=date(2026, 9, 20),
                    bill_due_date=date(2026, 9, 27),
                )
            ]
        },
    )
    svc = BankSyncService(db, provider)
    link = await svc.link_account(
        ws_id, pluggy_item_id="item-1", pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1), today=TODAY,
    )
    assert link.provider_balance_minor == -321_00
    assert link.credit_limit_minor == 1_000_00
    assert link.bill_close_date == date(2026, 9, 20)
    assert link.bill_due_date == date(2026, 9, 27)


# --------------------------------------------------------------------------- #
# sync_workspace / _sync_link
# --------------------------------------------------------------------------- #


async def test_sync_workspace_resync_dedupes_second_run_creates_zero(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={
            "acc-1": [_tx_row("tx-1", days_ago=5), _tx_row("tx-2", days_ago=6)]
        },
    )
    svc = BankSyncService(db, provider)
    first = await svc.sync_workspace(ws_id, today=TODAY)
    await db.commit()
    assert first["created"] == 2
    assert first["skipped"] == 0

    second = await svc.sync_workspace(ws_id, today=TODAY)
    await db.commit()
    assert second["created"] == 0
    assert second["skipped"] == 2


async def test_sync_workspace_tombstone_soft_deleted_row_not_recreated(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": [_tx_row("tx-1", days_ago=5)]},
    )
    svc = BankSyncService(db, provider)
    await svc.sync_workspace(ws_id, today=TODAY)
    await db.commit()

    tx = await db.scalar(sa.select(Transaction).where(Transaction.external_id == "tx-1"))
    tx.deleted_at = datetime.now(UTC)
    await db.commit()

    result = await svc.sync_workspace(ws_id, today=TODAY)
    await db.commit()
    assert result["created"] == 0
    assert result["skipped"] == 1

    still_absent = await db.scalar(
        sa.select(sa.func.count()).select_from(Transaction).where(
            Transaction.external_id == "tx-1", Transaction.deleted_at.is_(None)
        )
    )
    assert still_absent == 0


async def test_sync_workspace_overlap_window_never_earlier_than_sync_from(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    last_synced_at = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
    connection = await _connection(db, ws_id, last_synced_at=last_synced_at)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 9, 18))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    svc = BankSyncService(db, provider)
    await svc.sync_workspace(ws_id, today=TODAY)
    assert provider.transaction_calls == [("acc-1", date(2026, 9, 18))]  # clamped to sync_from


async def test_sync_workspace_overlap_window_subtracts_thirty_days_from_last_synced(db, initialized_instance):
    """Finding 6: the overlap window is 30 days (not 7) — wide enough to
    catch a PENDING card charge that only POSTs, with an occurred date
    dated earlier still, well after the previous sync round already passed
    it (a realistic card-posting delay); dedupe absorbs the re-fetch."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    last_synced_at = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
    connection = await _connection(db, ws_id, last_synced_at=last_synced_at)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    svc = BankSyncService(db, provider)
    await svc.sync_workspace(ws_id, today=TODAY)
    assert provider.transaction_calls == [("acc-1", date(2026, 8, 21))]  # 2026-09-20 - 30d


async def test_sync_workspace_pending_transactions_are_dropped(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={
            "acc-1": [_tx_row("tx-pending", days_ago=1, status="PENDING")]
        },
    )
    svc = BankSyncService(db, provider)
    result = await svc.sync_workspace(ws_id, today=TODAY)
    assert result["created"] == 0
    assert result["skipped"] == 0
    count = await db.scalar(sa.select(sa.func.count()).select_from(Transaction))
    assert count == 0


async def test_sync_workspace_category_mapping_hit_and_miss(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    category = await _category(db, ws_id, name="Food")
    db.add(BankCategoryMapping(id=uuid.uuid4(), workspace_id=ws_id, pluggy_category="Food", category_id=category.id))
    await db.flush()
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={
            "acc-1": [
                _tx_row("tx-mapped", days_ago=1, category="Food"),
                _tx_row("tx-unmapped", days_ago=2, category="Unknown"),
            ]
        },
    )
    svc = BankSyncService(db, provider)
    await svc.sync_workspace(ws_id, today=TODAY)
    mapped = await db.scalar(sa.select(Transaction).where(Transaction.external_id == "tx-mapped"))
    unmapped = await db.scalar(sa.select(Transaction).where(Transaction.external_id == "tx-unmapped"))
    assert mapped.category_id == category.id
    assert unmapped.category_id is None


async def test_sync_workspace_refreshes_card_fields_on_each_run(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", type="credit_card")
    connection = await _connection(db, ws_id)
    link = await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1), provider_balance_minor=0)
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                _bank_account(
                    type="CREDIT", subtype="CREDIT_CARD", currency="BRL", balance_minor=-777_00,
                    credit_limit_minor=2_000_00, bill_close_date=date(2026, 10, 1),
                    bill_due_date=date(2026, 10, 8),
                )
            ]
        },
    )
    svc = BankSyncService(db, provider)
    await svc.sync_workspace(ws_id, today=TODAY)
    await db.refresh(link)
    assert link.provider_balance_minor == -777_00
    assert link.credit_limit_minor == 2_000_00
    assert link.bill_close_date == date(2026, 10, 1)
    assert link.bill_due_date == date(2026, 10, 8)


async def test_sync_workspace_failed_link_import_does_not_write_new_provider_balance(db, initialized_instance):
    """Finding 2: `_sync_link` raising must not leave the freshly-read
    provider balance/card fields flushed — otherwise the except handler
    commits a balance the sync never actually confirmed by importing,
    Reconcile "fixes" a gap that isn't real, and the next successful sync
    then double-counts those same transactions."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    link = await _link(
        db, ws_id, connection, account, sync_from=date(2026, 1, 1), provider_balance_minor=100_00,
    )
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=999_00)]},
        raise_for_accounts={"acc-1"},
    )
    svc = BankSyncService(db, provider)
    result = await svc.sync_workspace(ws_id, today=TODAY)
    await db.commit()
    assert len(result["errors"]) == 1
    await db.refresh(link)
    assert link.provider_balance_minor == 100_00


async def test_sync_workspace_isolates_one_connection_error_from_the_other(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account_ok = await _account(db, ws_id, currency="BRL", name="OK")
    account_bad = await _account(db, ws_id, currency="BRL", name="Bad")
    connection_ok = await _connection(db, ws_id, pluggy_item_id="item-ok")
    connection_bad = await _connection(db, ws_id, pluggy_item_id="item-bad")
    await _link(db, ws_id, connection_ok, account_ok, pluggy_account_id="acc-ok", sync_from=date(2026, 1, 1))
    await _link(db, ws_id, connection_bad, account_bad, pluggy_account_id="acc-bad", sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[
            ProviderConnection(item_id="item-ok", institution_name="Bank", status="UPDATED"),
            ProviderConnection(item_id="item-bad", institution_name="Bank", status="UPDATED"),
        ],
        accounts_by_item={"item-ok": [_bank_account(pluggy_account_id="acc-ok", currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-ok": [_tx_row("tx-ok", days_ago=1)]},
        raise_for_items={"item-bad"},
    )
    svc = BankSyncService(db, provider)
    result = await svc.sync_workspace(ws_id, today=TODAY)
    await db.commit()

    assert result["connections"] == 2
    assert result["created"] == 1
    assert len(result["errors"]) == 1

    await db.refresh(connection_ok)
    await db.refresh(connection_bad)
    assert connection_ok.status == "ok"
    assert connection_bad.status == "error"
    assert connection_bad.last_error is not None

    actions = await _actions(db)
    assert Actions.BANK_SYNC_COMPLETED in actions
    assert Actions.BANK_SYNC_FAILED in actions


async def test_sync_workspace_failed_round_does_not_advance_last_synced_at(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))

    # Seed a real prior successful sync so last_synced_at has a genuine value.
    ok_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, ok_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()
    await db.refresh(connection)
    seeded_last_synced_at = connection.last_synced_at
    assert seeded_last_synced_at is not None

    # Now a round where the provider fails outright for this item.
    bad_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        raise_for_items={"item-1"},
    )
    result = await BankSyncService(db, bad_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()
    assert len(result["errors"]) == 1

    await db.refresh(connection)
    assert connection.last_synced_at == seeded_last_synced_at


async def test_sync_workspace_recovery_window_uses_pre_failure_last_synced_at(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))

    # Seed a real prior successful sync, then pin its persisted timestamp to
    # a known past date — makes the 7-day overlap window assertion below
    # unambiguous instead of depending on which wall-clock instant the test
    # happens to run at.
    ok_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, ok_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()
    connection.last_synced_at = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    await db.commit()

    # A round where the provider fails outright — must not move last_synced_at.
    bad_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        raise_for_items={"item-1"},
    )
    await BankSyncService(db, bad_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()

    # Recovery: the window must be computed from the pre-failure timestamp
    # (2026-09-01), not from whatever real time the failed round's `except`
    # block would have stamped — otherwise a gap opens between the two.
    recovery_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, recovery_provider).sync_workspace(ws_id, today=TODAY)

    expected_from = date(2026, 9, 1) - timedelta(days=SYNC_OVERLAP_DAYS)
    assert recovery_provider.transaction_calls == [("acc-1", expected_from)]


async def test_sync_workspace_item_login_error_marks_connection_error_with_raw_status(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="LOGIN_ERROR")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    svc = BankSyncService(db, provider)
    await svc.sync_workspace(ws_id, today=TODAY)
    await db.refresh(connection)
    assert connection.status == "error"
    assert connection.last_error == "LOGIN_ERROR"


async def test_sync_workspace_item_error_status_does_not_advance_last_synced_at(db, initialized_instance):
    """Finding 1: a LOGIN_ERROR round never raises (data is just stale), so
    the old code's bare `last_synced_at = now()` after the try block would
    silently advance it anyway. It must stay pinned at the last genuinely
    successful (UPDATED) round."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))

    ok_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, ok_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()
    await db.refresh(connection)
    seeded_last_synced_at = connection.last_synced_at
    assert seeded_last_synced_at is not None

    error_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="LOGIN_ERROR")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, error_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()
    await db.refresh(connection)
    assert connection.status == "error"
    assert connection.last_error == "LOGIN_ERROR"
    assert connection.last_synced_at == seeded_last_synced_at


async def test_sync_workspace_recovery_after_item_error_uses_pre_outage_last_synced_at(db, initialized_instance):
    """Finding 1, recovery half: once the login is repaired (status back to
    UPDATED), the overlap window must be computed from the timestamp of the
    last UPDATED round — not from "now" — so nothing that posted during the
    outage is skipped."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))

    ok_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, ok_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()
    connection.last_synced_at = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    await db.commit()

    error_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="LOGIN_ERROR")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, error_provider).sync_workspace(ws_id, today=TODAY)
    await db.commit()

    recovery_provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={"item-1": [_bank_account(currency="BRL", balance_minor=0)]},
        transactions_by_account={"acc-1": []},
    )
    await BankSyncService(db, recovery_provider).sync_workspace(ws_id, today=TODAY)

    expected_from = date(2026, 9, 1) - timedelta(days=SYNC_OVERLAP_DAYS)
    assert recovery_provider.transaction_calls == [("acc-1", expected_from)]


# --------------------------------------------------------------------------- #
# reconcile / unlink / delete_connection / mappings
# --------------------------------------------------------------------------- #


async def test_reconcile_posts_exactly_the_gap_then_balance_matches(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=100_00)
    connection = await _connection(db, ws_id)
    link = await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1), provider_balance_minor=500_00)
    svc = BankSyncService(db, FakeBankProvider())
    tx = await svc.reconcile(ws_id, link.id, today=TODAY)
    await db.commit()
    assert tx is not None
    assert tx.amount_minor == 400_00
    balance = await AccountService(db).balance(account)
    assert balance == 500_00
    actions = await _actions(db)
    assert Actions.ACCOUNT_BALANCE_RECONCILED in actions


async def test_reconcile_locks_the_account_row(db, engine, initialized_instance):
    """Finding 3: reconcile()'s balance()-then-write must take
    `SELECT ... FOR UPDATE` on the Account row — a double-clicked Reconcile,
    or one racing the daily sync job, must serialize rather than both reading
    the same stale balance and posting two adjustments."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=100_00)
    connection = await _connection(db, ws_id)
    link = await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1), provider_balance_minor=500_00)
    svc = BankSyncService(db, FakeBankProvider())

    statements: list[str] = []
    listener = _capture_sql(engine, statements)
    try:
        await svc.reconcile(ws_id, link.id, today=TODAY)
    finally:
        sa.event.remove(engine.sync_engine, "before_cursor_execute", listener)

    assert any("FOR UPDATE" in s.upper() and "accounts" in s.lower() for s in statements)


async def test_reconcile_twice_in_a_row_posts_only_one_adjustment(db, initialized_instance):
    """Belt-and-braces alongside the FOR-UPDATE assertion above: even without
    a real race, calling reconcile() a second time right after the first
    must see the already-closed gap and post nothing more."""
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=100_00)
    connection = await _connection(db, ws_id)
    link = await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1), provider_balance_minor=500_00)
    svc = BankSyncService(db, FakeBankProvider())

    first = await svc.reconcile(ws_id, link.id, today=TODAY)
    await db.commit()
    assert first is not None
    assert first.amount_minor == 400_00

    second = await svc.reconcile(ws_id, link.id, today=TODAY)
    await db.commit()
    assert second is None


async def test_reconcile_returns_none_when_gap_is_zero(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=500_00)
    connection = await _connection(db, ws_id)
    link = await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1), provider_balance_minor=500_00)
    svc = BankSyncService(db, FakeBankProvider())
    tx = await svc.reconcile(ws_id, link.id, today=TODAY)
    assert tx is None


async def test_unlink_keeps_transactions_and_connection(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    link = await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(transactions_by_account={"acc-1": [_tx_row("tx-1", days_ago=1)]})
    svc = BankSyncService(db, provider)
    await svc._sync_link(link, from_date=date(2026, 1, 1), today=TODAY)
    await db.commit()

    await svc.unlink(ws_id, link.id)
    await db.commit()

    remaining_link = await db.get(BankAccountLink, link.id)
    assert remaining_link is None
    still_there_connection = await db.get(BankConnection, connection.id)
    assert still_there_connection is not None
    tx_count = await db.scalar(
        sa.select(sa.func.count()).select_from(Transaction).where(Transaction.account_id == account.id)
    )
    assert tx_count == 1
    actions = await _actions(db)
    assert Actions.BANK_ACCOUNT_UNLINKED in actions


async def test_delete_connection_removes_links(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    link = await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1))
    svc = BankSyncService(db, FakeBankProvider())
    await svc.delete_connection(ws_id, connection.id)
    await db.commit()

    assert await db.get(BankConnection, connection.id) is None
    # The link row is removed by the DB-level ON DELETE CASCADE, not by the
    # ORM — db.get() would return the stale identity-mapped instance, so
    # query fresh instead.
    remaining = await db.scalar(
        sa.select(sa.func.count()).select_from(BankAccountLink).where(BankAccountLink.id == link.id)
    )
    assert remaining == 0
    actions = await _actions(db)
    assert Actions.BANK_CONNECTION_DELETED in actions


async def test_replace_mappings_validates_categories_and_round_trips(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    category = await _category(db, ws_id, name="Food")
    svc = BankSyncService(db, FakeBankProvider())
    rows = await svc.replace_mappings(ws_id, [("Food", category.id)])
    await db.commit()
    assert len(rows) == 1
    stored = await svc.list_mappings(ws_id)
    assert [(m.pluggy_category, m.category_id) for m in stored] == [("Food", category.id)]

    actions = await _actions(db)
    assert Actions.BANK_CATEGORY_MAPPINGS_REPLACED in actions


async def test_replace_mappings_raises_on_unknown_category(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    svc = BankSyncService(db, FakeBankProvider())
    try:
        await svc.replace_mappings(ws_id, [("Food", uuid.uuid4())])
        raise AssertionError("expected CategoryNotFoundError")
    except CategoryNotFoundError:
        pass


async def test_replace_mappings_replaces_previous_set(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    category_a = await _category(db, ws_id, name="Food")
    category_b = await _category(db, ws_id, name="Fuel")
    svc = BankSyncService(db, FakeBankProvider())
    await svc.replace_mappings(ws_id, [("Food", category_a.id)])
    await db.commit()
    rows = await svc.replace_mappings(ws_id, [("Fuel", category_b.id)])
    await db.commit()
    assert [(m.pluggy_category, m.category_id) for m in rows] == [("Fuel", category_b.id)]
    stored = await svc.list_mappings(ws_id)
    assert len(stored) == 1
    assert stored[0].pluggy_category == "Fuel"


# --------------------------------------------------------------------------- #
# discover / list_connections
# --------------------------------------------------------------------------- #


async def test_discover_annotates_linked_account_id(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, pluggy_account_id="acc-1", sync_from=date(2026, 1, 1))
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                _bank_account(pluggy_account_id="acc-1", currency="BRL", balance_minor=0),
                _bank_account(pluggy_account_id="acc-2", currency="BRL", balance_minor=0),
            ]
        },
    )
    svc = BankSyncService(db, provider)
    result = await svc.discover(ws_id)
    assert len(result) == 1
    accounts_by_id = {a["pluggy_account_id"]: a for a in result[0]["accounts"]}
    assert accounts_by_id["acc-1"]["linked_account_id"] == account.id
    assert accounts_by_id["acc-2"]["linked_account_id"] is None


async def test_list_connections_shapes_links_with_derived_balance(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id, currency="BRL", initial_balance_minor=1_000_00, name="Checking")
    connection = await _connection(db, ws_id)
    await _link(db, ws_id, connection, account, sync_from=date(2026, 1, 1), provider_balance_minor=1_000_00)
    svc = BankSyncService(db, FakeBankProvider())
    result = await svc.list_connections(ws_id)
    assert len(result) == 1
    assert result[0]["links"][0]["derived_balance_minor"] == 1_000_00
    assert result[0]["links"][0]["account_name"] == "Checking"
