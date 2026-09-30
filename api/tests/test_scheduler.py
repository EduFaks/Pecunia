"""Task 5 (Track Q): the daily in-process crypto price sync. Task 6 (Track T)
adds its sibling: the daily in-process bank sync. Both `run_daily_price_sync`
and `run_daily_bank_sync` are tested directly (invoked once) — never the 24h
timing loop, per the plan. `start_price_sync_task`/`start_bank_sync_task` are
the small, dependency-light factories the lifespan calls; their own tests
only check the gating, not the loop they may start."""

import asyncio
import uuid
from datetime import date

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from pecunia.config import Settings
from pecunia.models import (
    Account,
    BankAccountLink,
    BankConnection,
    Holding,
    Portfolio,
    Workspace,
    WorkspaceMembership,
)
from pecunia.scheduler import (
    run_daily_bank_sync,
    run_daily_price_sync,
    start_bank_sync_task,
    start_price_sync_task,
)
from pecunia.services.banksync.provider import (
    FakeBankProvider,
    ProviderAccount,
    ProviderConnection,
    ProviderTransaction,
)
from pecunia.services.banksync.sync import BankSyncService
from pecunia.services.prices.provider import FakePriceProvider
from pecunia.services.prices.refresh import PriceRefreshService

TODAY = date(2026, 9, 13)


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _holding(db, ws_id, *, coingecko_id="bitcoin", currency="USD"):
    portfolio = Portfolio(id=uuid.uuid4(), workspace_id=ws_id, name="P", currency=currency)
    db.add(portfolio)
    await db.flush()
    holding = Holding(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        portfolio_id=portfolio.id,
        name="H",
        quantity="1",
        coingecko_id=coingecko_id,
    )
    db.add(holding)
    await db.flush()
    return holding


async def test_run_daily_price_sync_refreshes_every_workspace(
    db, initialized_instance, engine, user_factory
):
    ws1_id = await _ws_id(db, initialized_instance)
    await _holding(db, ws1_id)

    other_user = await user_factory(email="other@example.com")
    ws2 = Workspace(id=uuid.uuid4(), name="Other")
    db.add(ws2)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws2.id, user_id=other_user.id, role="owner"))
    await db.commit()

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePriceProvider(prices_by_currency={"USD": {"bitcoin": 6_500_000}})
    results = await run_daily_price_sync(sessionmaker, provider, today=TODAY)

    assert results[str(ws1_id)] == {"updated": 1, "skipped": 0, "errors": []}
    # ws2 has no crypto holdings, but is still iterated — a no-op refresh.
    assert results[str(ws2.id)] == {"updated": 0, "skipped": 0, "errors": []}


async def test_run_daily_price_sync_isolates_a_failing_workspace(
    db, initialized_instance, engine, monkeypatch
):
    """One workspace's refresh blowing up (anything beyond the
    PriceRefreshService's own PriceProviderError handling — e.g. a bug, a
    DB hiccup) must log and let every other workspace's refresh proceed."""
    failing_ws_id = await _ws_id(db, initialized_instance)
    await _holding(db, failing_ws_id)
    await db.commit()

    async def _boom(self, workspace_id, *, today):
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(PriceRefreshService, "refresh", _boom)

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePriceProvider(prices_by_currency={"USD": {"bitcoin": 6_500_000}})
    # Must not raise — the failure is caught and logged, not propagated.
    results = await run_daily_price_sync(sessionmaker, provider, today=TODAY)

    assert str(failing_ws_id) not in results


async def test_run_daily_price_sync_with_no_workspaces_is_a_no_op(engine):
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePriceProvider()
    results = await run_daily_price_sync(sessionmaker, provider, today=TODAY)
    assert results == {}


def test_start_price_sync_task_returns_none_when_disabled():
    settings = Settings(enable_price_sync=False)
    assert start_price_sync_task(settings, sessionmaker=object()) is None


async def test_start_price_sync_task_starts_a_task_when_enabled(engine):
    settings = Settings(enable_price_sync=True)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    task = start_price_sync_task(settings, sessionmaker, provider=FakePriceProvider())
    assert isinstance(task, asyncio.Task)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# --------------------------------------------------------------------------- #
# Task 6 (Track T): daily bank sync
# --------------------------------------------------------------------------- #


async def _bank_account(db, ws_id, *, currency="BRL"):
    account = Account(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        name="Checking",
        type="checking",
        currency=currency,
        initial_balance_minor=0,
    )
    db.add(account)
    await db.flush()
    return account


async def _bank_connection_with_link(
    db, ws_id, account, *, pluggy_item_id="item-1", pluggy_account_id="acc-1"
):
    connection = BankConnection(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        pluggy_item_id=pluggy_item_id,
        institution_name="Bank",
        status="ok",
    )
    db.add(connection)
    await db.flush()
    link = BankAccountLink(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        connection_id=connection.id,
        account_id=account.id,
        pluggy_account_id=pluggy_account_id,
        sync_from=date(2026, 1, 1),
    )
    db.add(link)
    await db.flush()
    return connection


async def test_run_daily_bank_sync_syncs_every_workspace(
    db, initialized_instance, engine, user_factory
):
    ws1_id = await _ws_id(db, initialized_instance)
    account = await _bank_account(db, ws1_id)
    await _bank_connection_with_link(db, ws1_id, account)

    other_user = await user_factory(email="bank-other@example.com")
    ws2 = Workspace(id=uuid.uuid4(), name="Other")
    db.add(ws2)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws2.id, user_id=other_user.id, role="owner"))
    await db.commit()

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakeBankProvider(
        connections=[ProviderConnection(item_id="item-1", institution_name="Bank", status="UPDATED")],
        accounts_by_item={
            "item-1": [
                ProviderAccount(
                    pluggy_account_id="acc-1",
                    item_id="item-1",
                    type="BANK",
                    subtype="CHECKING_ACCOUNT",
                    name="Checking",
                    number="0001",
                    balance_minor=0,
                    currency="BRL",
                    credit_limit_minor=None,
                    bill_close_date=None,
                    bill_due_date=None,
                )
            ]
        },
        transactions_by_account={
            "acc-1": [
                ProviderTransaction(
                    external_id="tx-1",
                    date=TODAY,
                    description="Coffee",
                    amount_minor=-500,
                    currency="BRL",
                    status="POSTED",
                    pluggy_category=None,
                )
            ]
        },
    )
    results = await run_daily_bank_sync(sessionmaker, provider, today=TODAY)

    assert results[str(ws1_id)] == {"connections": 1, "created": 1, "skipped": 0, "errors": []}
    # ws2 has no bank connections, but is still iterated — a no-op sync.
    assert results[str(ws2.id)] == {"connections": 0, "created": 0, "skipped": 0, "errors": []}


async def test_run_daily_bank_sync_isolates_a_failing_workspace(
    db, initialized_instance, engine, user_factory, monkeypatch
):
    """One workspace's sync blowing up (anything beyond BankSyncService's own
    per-connection BankProviderError handling — e.g. a bug, a DB hiccup)
    must log and let every other workspace's sync proceed."""
    ws1_id = await _ws_id(db, initialized_instance)

    other_user = await user_factory(email="bank-other2@example.com")
    ws2 = Workspace(id=uuid.uuid4(), name="Other")
    db.add(ws2)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws2.id, user_id=other_user.id, role="owner"))
    await db.commit()

    async def _boom(self, workspace_id, *, today):
        if workspace_id == ws1_id:
            raise RuntimeError("simulated failure")
        return {"connections": 0, "created": 0, "skipped": 0, "errors": []}

    monkeypatch.setattr(BankSyncService, "sync_workspace", _boom)

    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakeBankProvider()
    # Must not raise — the failure is caught and logged, not propagated.
    results = await run_daily_bank_sync(sessionmaker, provider, today=TODAY)

    assert str(ws1_id) not in results
    assert results[str(ws2.id)] == {"connections": 0, "created": 0, "skipped": 0, "errors": []}


async def test_run_daily_bank_sync_with_no_workspaces_is_a_no_op(engine):
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakeBankProvider()
    results = await run_daily_bank_sync(sessionmaker, provider, today=TODAY)
    assert results == {}


def test_start_bank_sync_task_returns_none_when_disabled():
    settings = Settings(
        enable_bank_sync=False, pluggy_client_id="the-id", pluggy_client_secret="the-secret"
    )
    assert start_bank_sync_task(settings, sessionmaker=object()) is None


def test_start_bank_sync_task_returns_none_when_client_id_empty():
    settings = Settings(
        enable_bank_sync=True, pluggy_client_id="", pluggy_client_secret="the-secret"
    )
    assert start_bank_sync_task(settings, sessionmaker=object()) is None


def test_start_bank_sync_task_returns_none_when_client_secret_empty():
    settings = Settings(
        enable_bank_sync=True, pluggy_client_id="the-id", pluggy_client_secret=""
    )
    assert start_bank_sync_task(settings, sessionmaker=object()) is None


async def test_start_bank_sync_task_starts_a_task_when_enabled(engine):
    settings = Settings(
        enable_bank_sync=True, pluggy_client_id="the-id", pluggy_client_secret="the-secret"
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    task = start_bank_sync_task(settings, sessionmaker, provider=FakeBankProvider())
    assert isinstance(task, asyncio.Task)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def test_settings_reads_pluggy_and_bank_sync_env_vars(monkeypatch):
    monkeypatch.setenv("PECUNIA_PLUGGY_CLIENT_ID", "the-id")
    monkeypatch.setenv("PECUNIA_PLUGGY_CLIENT_SECRET", "the-secret")
    monkeypatch.setenv("PECUNIA_ENABLE_BANK_SYNC", "false")
    settings = Settings()
    assert settings.pluggy_client_id == "the-id"
    assert settings.pluggy_client_secret == "the-secret"
    assert settings.enable_bank_sync is False
