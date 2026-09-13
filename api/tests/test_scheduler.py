"""Task 5 (Track Q): the daily in-process crypto price sync. `run_daily_price_
sync` is tested directly (invoked once) — never the 24h timing loop, per the
plan. `start_price_sync_task` is the small, dependency-light factory the
lifespan calls; its own tests only check the gating, not the loop it may
start."""

import asyncio
import uuid
from datetime import date

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from pecunia.config import Settings
from pecunia.models import Holding, Portfolio, Workspace, WorkspaceMembership
from pecunia.scheduler import run_daily_price_sync, start_price_sync_task
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
