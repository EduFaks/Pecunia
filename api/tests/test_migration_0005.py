"""Coverage for 0005_bank_sync (bank-sync tables + transactions.external_id,
Track T — bank sync via Pluggy, v1.5).

The `pg_url` session fixture (conftest.py) already applies every migration up
to head — including this one — before any test runs, so schema-parity is
already re-checked by test_migration_0001.py::test_schema_parity on every
run. This file adds the behavioral assertions specific to 0005: the CHECK on
`bank_connections.status` rejects an invalid value, each new table round-trips
through the ORM, the four new UNIQUE constraints reject duplicates, the
partial unique index on `transactions(account_id, external_id)` allows any
number of NULLs but rejects a duplicate non-null pair, and `downgrade`
actually drops the three new tables (restoring head afterwards so later tests
still see them).
"""

import asyncio
import uuid
from datetime import date

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from pecunia.models import (
    Account,
    BankAccountLink,
    BankCategoryMapping,
    BankConnection,
    Category,
    Transaction,
)


async def _account(db, ws_id, name="Checking"):
    account = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type="checking", currency="USD"
    )
    db.add(account)
    await db.flush()
    return account


async def _category_id(db, ws_id):
    return await db.scalar(sa.select(Category.id).where(Category.workspace_id == ws_id).limit(1))


async def _connection(db, ws_id, pluggy_item_id="item-1"):
    connection = BankConnection(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        pluggy_item_id=pluggy_item_id,
        institution_name="Test Bank",
    )
    db.add(connection)
    await db.flush()
    return connection


async def test_bank_connection_status_check_constraint(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    db.add(
        BankConnection(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            pluggy_item_id="item-1",
            institution_name="Test Bank",
            status="syncing",
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_bank_connection_round_trips_through_the_orm(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    connection = BankConnection(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        pluggy_item_id="item-1",
        institution_name="Test Bank",
    )
    db.add(connection)
    await db.flush()
    connection_id = connection.id
    db.expire_all()

    reloaded = await db.get(BankConnection, connection_id)
    assert reloaded.pluggy_item_id == "item-1"
    assert reloaded.institution_name == "Test Bank"
    assert reloaded.status == "ok"
    assert reloaded.last_error is None
    assert reloaded.last_synced_at is None
    assert reloaded.is_demo is False
    assert reloaded.created_at is not None
    assert reloaded.updated_at is not None


async def test_bank_connection_workspace_id_pluggy_item_id_unique(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    await _connection(db, ws_id, pluggy_item_id="item-dup")
    db.add(
        BankConnection(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            pluggy_item_id="item-dup",
            institution_name="Another Bank",
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_bank_account_link_round_trips_through_the_orm(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    connection = await _connection(db, ws_id)
    account = await _account(db, ws_id)
    link = BankAccountLink(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        connection_id=connection.id,
        account_id=account.id,
        pluggy_account_id="acc-1",
        sync_from=date(2026, 1, 1),
        provider_balance_minor=100_000,
        provider_balance_as_of=sa.func.now(),
        credit_limit_minor=500_000,
        bill_close_date=date(2026, 9, 10),
        bill_due_date=date(2026, 9, 20),
    )
    db.add(link)
    await db.flush()
    link_id = link.id
    connection_id = connection.id
    account_id = account.id
    db.expire_all()

    reloaded = await db.get(BankAccountLink, link_id)
    assert reloaded.connection_id == connection_id
    assert reloaded.account_id == account_id
    assert reloaded.pluggy_account_id == "acc-1"
    assert reloaded.sync_from == date(2026, 1, 1)
    assert reloaded.provider_balance_minor == 100_000
    assert reloaded.provider_balance_as_of is not None
    assert reloaded.credit_limit_minor == 500_000
    assert reloaded.bill_close_date == date(2026, 9, 10)
    assert reloaded.bill_due_date == date(2026, 9, 20)
    assert reloaded.is_demo is False
    assert reloaded.created_at is not None
    assert reloaded.updated_at is not None


async def test_bank_account_link_account_id_unique(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    connection = await _connection(db, ws_id)
    account = await _account(db, ws_id)
    db.add(
        BankAccountLink(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            connection_id=connection.id,
            account_id=account.id,
            pluggy_account_id="acc-1",
            sync_from=date(2026, 1, 1),
        )
    )
    await db.flush()
    db.add(
        BankAccountLink(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            connection_id=connection.id,
            account_id=account.id,
            pluggy_account_id="acc-2",
            sync_from=date(2026, 1, 1),
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_bank_account_link_workspace_id_pluggy_account_id_unique(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    connection = await _connection(db, ws_id)
    account_a = await _account(db, ws_id, name="Checking A")
    account_b = await _account(db, ws_id, name="Checking B")
    db.add(
        BankAccountLink(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            connection_id=connection.id,
            account_id=account_a.id,
            pluggy_account_id="acc-dup",
            sync_from=date(2026, 1, 1),
        )
    )
    await db.flush()
    db.add(
        BankAccountLink(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            connection_id=connection.id,
            account_id=account_b.id,
            pluggy_account_id="acc-dup",
            sync_from=date(2026, 1, 1),
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_bank_category_mapping_round_trips_through_the_orm(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    category_id = await _category_id(db, ws_id)
    mapping = BankCategoryMapping(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        pluggy_category="Groceries",
        category_id=category_id,
    )
    db.add(mapping)
    await db.flush()
    mapping_id = mapping.id
    db.expire_all()

    reloaded = await db.get(BankCategoryMapping, mapping_id)
    assert reloaded.pluggy_category == "Groceries"
    assert reloaded.category_id == category_id
    assert reloaded.is_demo is False
    assert reloaded.created_at is not None
    assert reloaded.updated_at is not None


async def test_bank_category_mapping_workspace_id_pluggy_category_unique(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    category_id = await _category_id(db, ws_id)
    db.add(
        BankCategoryMapping(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            pluggy_category="Groceries",
            category_id=category_id,
        )
    )
    await db.flush()
    db.add(
        BankCategoryMapping(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            pluggy_category="Groceries",
            category_id=category_id,
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_transaction_external_id_null_coexist_but_duplicate_non_null_rejected(
    db, initialized_instance
):
    ws_id = initialized_instance["workspace_id"]
    account = await _account(db, ws_id)

    def _tx(external_id):
        return Transaction(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            account_id=account.id,
            amount_minor=-1_000,
            currency="USD",
            description="tx",
            occurred_on=date(2026, 9, 11),
            external_id=external_id,
        )

    # Two NULL external_ids on the same account coexist fine — the unique
    # index is partial (`WHERE external_id IS NOT NULL`).
    db.add_all([_tx(None), _tx(None)])
    await db.flush()

    db.add(_tx("ext-1"))
    await db.flush()
    db.add(_tx("ext-1"))
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_downgrade_drops_bank_sync_tables_then_upgrade_restores_them(pg_url, engine):
    def _table_names(sync_conn) -> set[str]:
        inspector = sa.inspect(sync_conn)
        return set(inspector.get_table_names())

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", pg_url)
    try:
        # alembic's async env.py drives migrations via `asyncio.run(...)`
        # internally — running that straight from this coroutine would nest
        # event loops, so it goes through a thread instead (mirrors how the
        # sync `pg_url` fixture calls `command.upgrade` outside any loop).
        await asyncio.to_thread(command.downgrade, cfg, "0004")
        async with engine.connect() as conn:
            tables = await conn.run_sync(_table_names)
        assert "bank_connections" not in tables
        assert "bank_account_links" not in tables
        assert "bank_category_mappings" not in tables
    finally:
        await asyncio.to_thread(command.upgrade, cfg, "head")

    async with engine.connect() as conn:
        tables = await conn.run_sync(_table_names)
    assert "bank_connections" in tables
    assert "bank_account_links" in tables
    assert "bank_category_mappings" in tables
