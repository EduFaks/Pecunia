import os
import uuid

# Docker Desktop for Linux exposes no /var/run/docker.sock; the Ryuk reaper
# sidecar cannot bind-mount the socket there. Containers are stopped by the
# context manager on normal exit; a hard kill can leave an orphan without Ryuk.
if not os.path.exists("/var/run/docker.sock"):
    os.environ.setdefault("TESTCONTAINERS_RYUK_DISABLED", "true")

# Belt-and-braces: PECUNIA_ENABLE_PRICE_SYNC defaults to true, and a handful
# of tests (test_lifespan.py) boot the *real* ASGI lifespan — which would
# otherwise start the daily crypto sync task with a real CoinGeckoProvider
# against whatever's in the shared session DB at that moment. Tests that
# specifically exercise the scheduler (test_scheduler.py) construct their own
# `Settings(enable_price_sync=...)` directly, which overrides this.
os.environ.setdefault("PECUNIA_ENABLE_PRICE_SYNC", "false")

import httpx
import pytest
import sqlalchemy as sa
from alembic.config import Config
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

from alembic import command
from pecunia.events import event_bus
from pecunia.services.subscribers import register_subscribers

TEST_SECRET_KEY = "t" * 64

register_subscribers(event_bus)


@pytest.fixture(scope="session")
def pg_url():
    """Throwaway Postgres for the whole test session, migrated to head."""
    with PostgresContainer("postgres:17-alpine", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        os.environ["PECUNIA_DATABASE_URL"] = url
        cfg = Config("alembic.ini")
        cfg.set_main_option("sqlalchemy.url", url)
        command.upgrade(cfg, "head")
        yield url


@pytest.fixture
async def engine(pg_url):
    eng = create_async_engine(pg_url)
    yield eng
    await eng.dispose()


@pytest.fixture
async def _pg_clean(engine):
    """Reset identity/auth/audit state after each test (order respects FKs)."""
    yield
    async with engine.begin() as conn:
        # audit_events blocks DELETE via an append-only trigger; TRUNCATE bypasses
        # row-level triggers and resets the identity sequence in one statement.
        await conn.execute(sa.text("TRUNCATE audit_events, activity_entries RESTART IDENTITY"))
        await conn.execute(
            sa.text("UPDATE instance_state SET initialized_at = NULL, owner_user_id = NULL, settings = NULL WHERE id = 1")
        )
        for table in (
            "auth_sessions",
            "login_attempts",
            # project_items before transactions (project_items.transaction_id →
            # transactions SET NULL) and before projects; transactions before
            # projects (transactions.project_id → projects SET NULL). SET NULL
            # never blocks a DELETE, but this keeps children-before-parents
            # order, matching demo._TABLES.
            "project_items",
            # scheduled_transactions before accounts (account_id → accounts
            # CASCADE) and before categories/contacts (category_id/contact_id →
            # SET NULL) — children before parents, matching demo._TABLES.
            "scheduled_transactions",
            # transactions before transfers (transactions.transfer_id → transfers
            # CASCADE), and transfers before accounts (transfers.from/to_account_id
            # → accounts CASCADE) — children before parents down the transfer chain.
            "transactions",
            "transfers",
            "accounts",
            "asset_valuations",
            "assets",
            # holding_prices before holdings (holding_id → holdings CASCADE) and
            # holdings before portfolios (portfolio_id → portfolios CASCADE) —
            # children before parents, matching demo._TABLES.
            "holding_prices",
            "holdings",
            "portfolios",
            # loan_payments before loans (loan_id → loans CASCADE) — children
            # before parents, matching demo._TABLES.
            "loan_payments",
            "loans",
            # subscriptions reference accounts/contacts/categories (all SET NULL)
            # and workspaces (CASCADE); delete them before those parents —
            # children before parents, matching demo._TABLES.
            "subscriptions",
            "projects",
            "budgets",
            "contacts",
            "categories",
            # net_worth_snapshots references only workspaces (CASCADE) and has
            # no children — delete it before workspaces.
            "net_worth_snapshots",
            "workspace_memberships",
            "workspaces",
            "users",
        ):
            await conn.execute(sa.text(f"DELETE FROM {table}"))


@pytest.fixture
async def db(engine, _pg_clean):
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        yield session


@pytest.fixture
async def app(engine, _pg_clean):
    from pecunia.db import get_db
    from pecunia.main import create_app

    application = create_app()
    application.state.secret_key = TEST_SECRET_KEY
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def _get_db():
        async with maker() as session:
            yield session

    application.dependency_overrides[get_db] = _get_db
    return application


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def user_factory(db):
    async def _create(
        email: str = "owner@example.com",
        password: str = "correct horse battery staple",
        name: str = "Owner",
    ):
        from pecunia.models import User
        from pecunia.security.passwords import hash_password

        user = User(id=uuid.uuid4(), email=email, name=name, password_hash=hash_password(password))
        db.add(user)
        await db.flush()
        return user

    return _create


# Preferences an initialized instance carries in production (spec: setup
# always writes instance_state.settings) — matches the shape used across the
# setup/auth tests so a demo-seeding test can read base_currency back off it.
DEFAULT_PREFERENCES = {
    "base_currency": "BRL",
    "locale": "pt-BR",
    "date_format": "DD/MM/YYYY",
    "number_format": "1.234,56",
    "timezone": "America/Sao_Paulo",
    "first_day_of_week": "monday",
}


@pytest.fixture
async def initialized_instance(db, user_factory):
    from pecunia.models import InstanceState, Workspace, WorkspaceMembership
    from pecunia.services.categories import seed_default_categories

    user = await user_factory()
    ws = Workspace(id=uuid.uuid4(), name="Personal")
    db.add(ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws.id, user_id=user.id, role="owner"))
    # Mirrors the real initialize_instance (services/setup.py), which seeds the
    # workspace's default categories as part of setup — a workspace built by
    # this fixture without them is not representative of a real onboarded
    # workspace (it previously masked the onboard->demo 500: demo re-seeding
    # the same defaults only collides once the workspace already has them).
    await seed_default_categories(db, ws.id)
    await db.execute(
        sa.text(
            "UPDATE instance_state SET initialized_at = now(), owner_user_id = :uid WHERE id = 1"
        ).bindparams(uid=user.id)
    )
    state = await db.get(InstanceState, 1)
    state.settings = dict(DEFAULT_PREFERENCES)  # copy — never hand out the shared literal
    await db.commit()
    return {
        "user": user,
        "email": "owner@example.com",
        "password": "correct horse battery staple",
        "workspace_id": ws.id,
    }
