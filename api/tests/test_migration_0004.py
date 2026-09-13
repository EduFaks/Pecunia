"""Coverage for 0004_goals (goals table, Track S — savings goals, v1.4).

The `pg_url` session fixture (conftest.py) already applies every migration up
to head — including this one — before any test runs, so schema-parity is
already re-checked by test_migration_0001.py::test_schema_parity on every
run. This file adds the behavioral assertions specific to 0004: the CHECK on
`source_kind` rejects an invalid value, a row round-trips through the ORM,
and `downgrade` actually drops the table (restoring head afterwards so later
tests still see it).
"""

import asyncio
import uuid

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from pecunia.models import Goal, WorkspaceMembership


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def test_goal_source_kind_check_constraint(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    db.add(
        Goal(
            id=uuid.uuid4(),
            workspace_id=ws_id,
            name="Bad",
            target_minor=1_000,
            currency="USD",
            source_kind="not_a_real_kind",
        )
    )
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_goal_round_trips_through_the_orm(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    goal = Goal(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        name="Emergency fund",
        target_minor=500_000,
        currency="USD",
        source_kind="manual",
        manual_current_minor=100_000,
    )
    db.add(goal)
    await db.flush()
    goal_id = goal.id
    db.expire_all()

    reloaded = await db.get(Goal, goal_id)
    assert reloaded.name == "Emergency fund"
    assert reloaded.target_minor == 500_000
    assert reloaded.currency == "USD"
    assert reloaded.source_kind == "manual"
    assert reloaded.manual_current_minor == 100_000
    assert reloaded.source_id is None
    assert reloaded.target_date is None
    assert reloaded.created_at is not None


async def test_downgrade_drops_goals_then_upgrade_restores_it(pg_url, engine):
    def _has_table(sync_conn) -> bool:
        inspector = sa.inspect(sync_conn)
        return "goals" in inspector.get_table_names()

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", pg_url)
    try:
        # alembic's async env.py drives migrations via `asyncio.run(...)`
        # internally — running that straight from this coroutine would nest
        # event loops, so it goes through a thread instead (mirrors how the
        # sync `pg_url` fixture calls `command.upgrade` outside any loop).
        await asyncio.to_thread(command.downgrade, cfg, "0003")
        async with engine.connect() as conn:
            assert await conn.run_sync(_has_table) is False
    finally:
        await asyncio.to_thread(command.upgrade, cfg, "head")

    async with engine.connect() as conn:
        assert await conn.run_sync(_has_table) is True
