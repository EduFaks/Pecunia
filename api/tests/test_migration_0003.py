"""Coverage for 0003_holding_coingecko_id (holdings.coingecko_id, additive on
top of 0002_loan_contact).

The `pg_url` session fixture (conftest.py) already applies every migration up
to head — including this one — before any test runs, so schema-parity is
already re-checked by test_migration_0001.py::test_schema_parity on every
run. This file adds the two behavioral assertions specific to 0003: the new
column is nullable and round-trips through the ORM, and `downgrade` actually
drops it (restoring head afterwards so later tests still see the column).
"""

import asyncio
import uuid

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from pecunia.models import Holding, Portfolio, WorkspaceMembership


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def test_holding_coingecko_id_is_nullable_and_round_trips(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    portfolio = Portfolio(id=uuid.uuid4(), workspace_id=ws_id, name="Crypto", currency="USD")
    db.add(portfolio)
    await db.flush()

    priced = Holding(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        portfolio_id=portfolio.id,
        name="Bitcoin",
        quantity="1.5",
        coingecko_id="bitcoin",
    )
    manual = Holding(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        portfolio_id=portfolio.id,
        name="Fund",
        quantity="1",
    )
    db.add_all([priced, manual])
    await db.flush()
    priced_id, manual_id = priced.id, manual.id
    db.expire_all()

    reloaded_priced = await db.get(Holding, priced_id)
    reloaded_manual = await db.get(Holding, manual_id)
    assert reloaded_priced.coingecko_id == "bitcoin"
    assert reloaded_manual.coingecko_id is None


async def test_downgrade_drops_coingecko_id_then_upgrade_restores_it(pg_url, engine):
    def _has_column(sync_conn) -> bool:
        inspector = sa.inspect(sync_conn)
        return "coingecko_id" in {c["name"] for c in inspector.get_columns("holdings")}

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", pg_url)
    try:
        # alembic's async env.py drives migrations via `asyncio.run(...)`
        # internally — running that straight from this coroutine would nest
        # event loops, so it goes through a thread instead (mirrors how the
        # sync `pg_url` fixture calls `command.upgrade` outside any loop).
        await asyncio.to_thread(command.downgrade, cfg, "0002")
        async with engine.connect() as conn:
            assert await conn.run_sync(_has_column) is False
    finally:
        await asyncio.to_thread(command.upgrade, cfg, "head")

    async with engine.connect() as conn:
        assert await conn.run_sync(_has_column) is True
