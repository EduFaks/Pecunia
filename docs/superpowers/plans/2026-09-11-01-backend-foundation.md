# Plan 01 — Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot a Postgres + FastAPI stack via `docker compose up` that auto-migrates, auto-manages its secret key, and serves `GET /api/v1/setup/status` → `{"initialized": false}` — with a pytest + Postgres-testcontainer harness every later plan builds on.

**Architecture:** Async FastAPI app factory (`create_app`) with routers under `/api/v1`; SQLAlchemy 2 async (asyncpg) with Alembic async migrations; a singleton `instance_state` row drives the initialized/uninitialized gates (spec D4); secret-key resolution generates-and-persists to a config volume or refuses weak configured keys (spec §6).

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 (async, asyncpg), Alembic, pydantic-settings, uv (env/deps), pytest + pytest-asyncio + httpx + testcontainers[postgres], Docker Compose, postgres:17-alpine.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-pecunia-v1-design.md`. Deviations require a spec update.
- Exactly three containers ever: `pecunia-web`, `pecunia-api`, `pecunia-db`. This plan ships `pecunia-api` + `pecunia-db`; the API port is published directly until Plan 08 adds `pecunia-web`.
- No Redis/Celery/queues/workers. No new infrastructure of any kind (spec D6).
- All env vars are `PECUNIA_`-prefixed. Default published port `8480`.
- Setup/initialized state is enforced by router-level dependencies returning `409` with detail `SETUP_REQUIRED` / `SETUP_ALREADY_COMPLETE` — exact strings (spec D4).
- Secret key: empty → generate 64-hex-char key, persist `0600` to config dir, reuse; configured but `< 32` chars or a known placeholder → refuse to start (spec §6 step 4).
- Python: `api/` uses a `src/` layout, package `pecunia`. Run tooling via `uv run …` from `api/`.
- Commit after every green test cycle. Commit messages: conventional (`feat:`, `test:`, `chore:`).

---

## File Structure (end state of this plan)

```
.env.example                      compose-facing defaults, everything optional
.gitignore
README.md                         quickstart stub
docker-compose.yml                pecunia-db + pecunia-api
api/
├── pyproject.toml                deps, pytest & ruff config
├── alembic.ini
├── alembic/
│   ├── env.py                    async migrations, url from settings
│   ├── script.py.mako
│   └── versions/
│       └── 0001_instance_state.py
├── Dockerfile
├── docker/entrypoint.sh          wait-for-db → migrate → uvicorn
├── src/pecunia/
│   ├── __init__.py
│   ├── main.py                   create_app() + lifespan (secret resolution)
│   ├── config.py                 Settings (pydantic-settings)
│   ├── secrets.py                resolve_secret_key()
│   ├── db.py                     engine, async_sessionmaker, get_db
│   ├── wait_for_db.py            bounded retry loop (entrypoint step 1)
│   ├── models/
│   │   ├── __init__.py           imports all models (metadata registry)
│   │   ├── base.py               DeclarativeBase + naming convention
│   │   └── instance.py           InstanceState singleton
│   └── api/
│       ├── __init__.py
│       ├── health.py             GET /health
│       ├── deps.py               get_instance_state / require_(un)initialized
│       └── setup.py              GET /setup/status
└── tests/
    ├── conftest.py               pg container, migrations, engine/db/app/client
    ├── test_health.py
    ├── test_secrets.py
    ├── test_db.py
    ├── test_instance_state.py
    └── test_setup_status.py
```

---

### Task 1: API scaffold + health endpoint

**Files:**
- Create: `api/pyproject.toml`, `api/src/pecunia/__init__.py`, `api/src/pecunia/main.py`, `api/src/pecunia/api/__init__.py`, `api/src/pecunia/api/health.py`, `api/tests/test_health.py`, `.gitignore`

**Interfaces:**
- Produces: `pecunia.main.create_app() -> FastAPI` (all later tasks mount onto it); routers live in `pecunia.api.*` and are included with `prefix="/api/v1"`.

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# python
__pycache__/
*.pyc
.venv/
.pytest_cache/
.ruff_cache/
dist/

# env & data
.env
data/

# node (later plans)
node_modules/
```

- [ ] **Step 2: Create `api/pyproject.toml`**

```toml
[project]
name = "pecunia"
version = "0.1.0"
description = "Pecunia — self-hosted personal finance"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "sqlalchemy[asyncio]>=2.0.35",
    "asyncpg>=0.29",
    "alembic>=1.13",
    "pydantic-settings>=2.4",
]

[dependency-groups]
dev = [
    "pytest>=8",
    "pytest-asyncio>=0.24",
    "httpx>=0.27",
    "testcontainers[postgres]>=4.8",
    "ruff>=0.6",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/pecunia"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
```

- [ ] **Step 3: Write the failing test** — `api/tests/test_health.py`

```python
import httpx

from pecunia.main import create_app


async def test_health_returns_ok():
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd api && uv sync && uv run pytest tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pecunia'` (or import error for `create_app`)

- [ ] **Step 5: Implement scaffold**

`api/src/pecunia/__init__.py` and `api/src/pecunia/api/__init__.py` — empty files.

`api/src/pecunia/api/health.py`:

```python
from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

`api/src/pecunia/main.py`:

```python
from fastapi import FastAPI

from pecunia.api.health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="Pecunia",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.include_router(health_router, prefix="/api/v1")
    return app


app = create_app()
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd api && uv sync && uv run pytest tests/test_health.py -v`
Expected: PASS (1 passed)

- [ ] **Step 7: Commit**

```bash
git add .gitignore api
git commit -m "feat: FastAPI scaffold with health endpoint"
```

---

### Task 2: Settings + secret-key resolution

**Files:**
- Create: `api/src/pecunia/config.py`, `api/src/pecunia/secrets.py`
- Modify: `api/src/pecunia/main.py` (lifespan resolves the key at boot)
- Test: `api/tests/test_secrets.py`

**Interfaces:**
- Produces: `pecunia.config.Settings` (fields `database_url: str`, `secret_key: str`, `config_dir: Path`), `pecunia.config.get_settings() -> Settings`; `pecunia.secrets.resolve_secret_key(configured: str, config_dir: Path) -> str` raising `pecunia.secrets.WeakSecretError`. Resolved key available at runtime as `app.state.secret_key` (Plan 02's JWT service reads it).

- [ ] **Step 1: Write the failing tests** — `api/tests/test_secrets.py`

```python
import pytest

from pecunia.secrets import WeakSecretError, resolve_secret_key


def test_configured_strong_key_is_used(tmp_path):
    key = "a" * 64
    assert resolve_secret_key(key, tmp_path) == key


def test_short_configured_key_refused(tmp_path):
    with pytest.raises(WeakSecretError):
        resolve_secret_key("too-short", tmp_path)


def test_placeholder_key_refused(tmp_path):
    with pytest.raises(WeakSecretError):
        resolve_secret_key("change-me", tmp_path)


def test_generated_key_is_persisted_and_reused(tmp_path):
    first = resolve_secret_key("", tmp_path)
    second = resolve_secret_key("", tmp_path)
    assert first == second
    assert len(first) == 64  # 32 random bytes, hex-encoded
    keyfile = tmp_path / "secret_key"
    assert keyfile.read_text().strip() == first
    assert (keyfile.stat().st_mode & 0o777) == 0o600
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_secrets.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pecunia.secrets'`

- [ ] **Step 3: Implement**

`api/src/pecunia/config.py`:

```python
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PECUNIA_", extra="ignore")

    database_url: str = "postgresql+asyncpg://pecunia:pecunia@localhost:5432/pecunia"
    secret_key: str = ""
    config_dir: Path = Path("data/config")


def get_settings() -> Settings:
    return Settings()
```

`api/src/pecunia/secrets.py`:

```python
import secrets as _secrets
from pathlib import Path

MIN_KEY_LENGTH = 32
PLACEHOLDER_KEYS = {"change-me", "changeme", "secret", "insecure", "example", "password"}


class WeakSecretError(RuntimeError):
    """Raised when a configured PECUNIA_SECRET_KEY is unusable."""


def resolve_secret_key(configured: str, config_dir: Path) -> str:
    if configured:
        if len(configured) < MIN_KEY_LENGTH or configured.lower() in PLACEHOLDER_KEYS:
            raise WeakSecretError(
                "PECUNIA_SECRET_KEY is set but too weak (need 32+ random characters). "
                "Unset it to let Pecunia generate and persist one, or set a strong value."
            )
        return configured

    keyfile = config_dir / "secret_key"
    if keyfile.exists():
        key = keyfile.read_text().strip()
        if key:
            return key

    key = _secrets.token_hex(32)
    config_dir.mkdir(parents=True, exist_ok=True)
    keyfile.write_text(key)
    keyfile.chmod(0o600)
    return key
```

Replace `api/src/pecunia/main.py` in full (adds lifespan; note `httpx.ASGITransport` does not run lifespan, so tests are unaffected while Docker boots do resolve the key):

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from pecunia.api.health import router as health_router
from pecunia.config import get_settings
from pecunia.secrets import resolve_secret_key


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.secret_key = resolve_secret_key(settings.secret_key, settings.config_dir)
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="Pecunia",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.include_router(health_router, prefix="/api/v1")
    return app


app = create_app()
```

- [ ] **Step 4: Run the full suite to verify green**

Run: `cd api && uv run pytest -v`
Expected: PASS (5 passed — health + 4 secrets)

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "feat: settings and secret-key resolution with weak-key refusal"
```

---

### Task 3: Database layer, Alembic, and the Postgres test harness

**Files:**
- Create: `api/src/pecunia/db.py`, `api/src/pecunia/models/__init__.py`, `api/src/pecunia/models/base.py`, `api/alembic.ini`, `api/alembic/env.py`, `api/alembic/script.py.mako`, `api/alembic/versions/` (empty dir, add `.gitkeep`), `api/tests/conftest.py`
- Test: `api/tests/test_db.py`

**Interfaces:**
- Consumes: `pecunia.config.get_settings()` (Task 2).
- Produces: `pecunia.db.get_db()` async-generator dependency yielding `AsyncSession` (every endpoint uses it; tests override it); `pecunia.models.base.Base` (all models inherit it); conftest fixtures `pg_url` (session), `engine`, `db` (AsyncSession), `app` (FastAPI with `get_db` overridden), `client` (httpx AsyncClient) — every later plan's tests consume these. Alembic reads its URL from `sqlalchemy.url` if set, else `PECUNIA_DATABASE_URL`.

> **Requires Docker running locally** (testcontainers starts a throwaway `postgres:17-alpine`). This is the test DB strategy for the whole project: real Postgres, because the spec relies on `CHECK` constraints, row locks, triggers, and `citext`.

- [ ] **Step 1: Write the failing test** — `api/tests/test_db.py`

```python
import sqlalchemy as sa


async def test_database_connection(db):
    result = await db.execute(sa.text("SELECT 1"))
    assert result.scalar_one() == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_db.py -v`
Expected: FAIL — fixture `db` not found

- [ ] **Step 3: Implement DB layer**

`api/src/pecunia/models/base.py`:

```python
from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
```

`api/src/pecunia/models/__init__.py` (models register here as they are created; Task 4 adds the first):

```python
from pecunia.models.base import Base

__all__ = ["Base"]
```

`api/src/pecunia/db.py`:

```python
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from pecunia.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def init_engine(database_url: str | None = None) -> AsyncEngine:
    global _engine, _sessionmaker
    url = database_url or get_settings().database_url
    _engine = create_async_engine(url, pool_pre_ping=True)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def get_db() -> AsyncIterator[AsyncSession]:
    if _sessionmaker is None:
        init_engine()
    assert _sessionmaker is not None
    async with _sessionmaker() as session:
        yield session
```

- [ ] **Step 4: Implement Alembic wiring**

`api/alembic.ini`:

```ini
[alembic]
script_location = alembic
sqlalchemy.url =

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARNING
handlers = console

[logger_sqlalchemy]
level = WARNING
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
```

`api/alembic/env.py`:

```python
import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

import pecunia.models  # noqa: F401  — populates Base.metadata
from pecunia.config import get_settings
from pecunia.models.base import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def get_url() -> str:
    return config.get_main_option("sqlalchemy.url") or get_settings().database_url


def run_migrations_offline() -> None:
    context.configure(url=get_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    cfg = config.get_section(config.config_ini_section, {})
    cfg["sqlalchemy.url"] = get_url()
    connectable = async_engine_from_config(cfg, prefix="sqlalchemy.", poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

`api/alembic/script.py.mako`:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""
import sqlalchemy as sa
from alembic import op
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

Create `api/alembic/versions/.gitkeep` (empty file).

- [ ] **Step 5: Implement the test harness** — `api/tests/conftest.py`

```python
import os

import httpx
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer


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
async def db(engine):
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        yield session


@pytest.fixture
async def app(engine):
    from pecunia.db import get_db
    from pecunia.main import create_app

    application = create_app()
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd api && uv sync && uv run pytest tests/test_db.py -v`
Expected: PASS (container pulls/starts on first run — allow ~1 min; `alembic upgrade head` is a clean no-op with zero revisions)

- [ ] **Step 7: Run the full suite, then commit**

Run: `cd api && uv run pytest -v` — Expected: all pass.

```bash
git add api
git commit -m "feat: async db layer, alembic wiring, postgres test harness"
```

---

### Task 4: `instance_state` singleton — model, migration, seed

**Files:**
- Create: `api/src/pecunia/models/instance.py`, `api/alembic/versions/0001_instance_state.py`
- Modify: `api/src/pecunia/models/__init__.py`
- Test: `api/tests/test_instance_state.py`

**Interfaces:**
- Produces: `pecunia.models.instance.InstanceState` — columns `id: int (=1)`, `instance_id: uuid.UUID`, `initialized_at: datetime | None`, `owner_user_id: uuid.UUID | None`, `created_at: datetime`. Plan 02's `POST /setup/initialize` will `SELECT … FOR UPDATE` this row and set `initialized_at`/`owner_user_id`.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_instance_state.py`

```python
import pytest
import sqlalchemy as sa

from pecunia.models.instance import InstanceState


async def test_singleton_row_seeded_uninitialized(db):
    state = await db.get(InstanceState, 1)
    assert state is not None
    assert state.initialized_at is None
    assert state.owner_user_id is None
    assert state.instance_id is not None


async def test_second_row_rejected_by_check_constraint(db):
    with pytest.raises(sa.exc.IntegrityError):
        await db.execute(
            sa.text("INSERT INTO instance_state (id, instance_id) VALUES (2, gen_random_uuid())")
        )
    await db.rollback()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_instance_state.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pecunia.models.instance'`

- [ ] **Step 3: Implement model + migration**

`api/src/pecunia/models/instance.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Uuid

from pecunia.models.base import Base


class InstanceState(Base):
    """Singleton row (id = 1). initialized_at IS NULL ⇒ wizard mode (spec D4)."""

    __tablename__ = "instance_state"
    __table_args__ = (CheckConstraint("id = 1", name="singleton"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    instance_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    initialized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
```

Replace `api/src/pecunia/models/__init__.py`:

```python
from pecunia.models.base import Base
from pecunia.models.instance import InstanceState

__all__ = ["Base", "InstanceState"]
```

`api/alembic/versions/0001_instance_state.py` (hand-written, not autogenerated, so the seed insert is part of the revision):

```python
"""instance_state singleton

Revision ID: 0001
Revises:
Create Date: 2026-09-11
"""
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "instance_state",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("instance_id", sa.Uuid, nullable=False),
        sa.Column("initialized_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("owner_user_id", sa.Uuid, nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint("id = 1", name="ck_instance_state_singleton"),
    )
    op.execute(f"INSERT INTO instance_state (id, instance_id) VALUES (1, '{uuid.uuid4()}')")


def downgrade() -> None:
    op.drop_table("instance_state")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_instance_state.py -v`
Expected: PASS (2 passed) — the session fixture re-runs migrations on a fresh container, so the new revision applies automatically.

- [ ] **Step 5: Run the full suite, then commit**

Run: `cd api && uv run pytest -v` — Expected: all pass.

```bash
git add api
git commit -m "feat: instance_state singleton model, migration, and seed"
```

---

### Task 5: Setup status endpoint + initialized/uninitialized gates

**Files:**
- Create: `api/src/pecunia/api/deps.py`, `api/src/pecunia/api/setup.py`
- Modify: `api/src/pecunia/main.py` (include setup router)
- Test: `api/tests/test_setup_status.py`

**Interfaces:**
- Consumes: `get_db` (Task 3), `InstanceState` (Task 4).
- Produces: `pecunia.api.deps.get_instance_state`, `require_initialized`, `require_uninitialized` — FastAPI dependencies. Plan 02 guards `POST /setup/initialize` with `require_uninitialized`; Plans 02–04 guard every domain router with `require_initialized`. `GET /api/v1/setup/status` → `{"initialized": bool}` (the SPA's routing signal, spec D4).

- [ ] **Step 1: Write the failing tests** — `api/tests/test_setup_status.py`

```python
import httpx
import sqlalchemy as sa
from fastapi import Depends


async def test_status_reports_uninitialized(client):
    resp = await client.get("/api/v1/setup/status")
    assert resp.status_code == 200
    assert resp.json() == {"initialized": False}


async def test_require_initialized_blocks_while_uninitialized(app):
    from pecunia.api.deps import require_initialized

    @app.get("/api/v1/_gated", dependencies=[Depends(require_initialized)])
    async def _gated():
        return {"ok": True}

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/_gated")
    assert resp.status_code == 409
    assert resp.json()["detail"] == "SETUP_REQUIRED"


async def test_initialized_flips_status_and_gates(app, db):
    from pecunia.api.deps import require_uninitialized

    @app.get("/api/v1/_setup-only", dependencies=[Depends(require_uninitialized)])
    async def _setup_only():
        return {"ok": True}

    await db.execute(sa.text("UPDATE instance_state SET initialized_at = now() WHERE id = 1"))
    await db.commit()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            status = await client.get("/api/v1/setup/status")
            gated = await client.get("/api/v1/_setup-only")
        assert status.json() == {"initialized": True}
        assert gated.status_code == 409
        assert gated.json()["detail"] == "SETUP_ALREADY_COMPLETE"
    finally:
        await db.execute(sa.text("UPDATE instance_state SET initialized_at = NULL WHERE id = 1"))
        await db.commit()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_setup_status.py -v`
Expected: FAIL — first test 404 (no route), others `ModuleNotFoundError: pecunia.api.deps`

- [ ] **Step 3: Implement**

`api/src/pecunia/api/deps.py`:

```python
from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.db import get_db
from pecunia.models.instance import InstanceState


async def get_instance_state(db: Annotated[AsyncSession, Depends(get_db)]) -> InstanceState:
    state = await db.get(InstanceState, 1)
    if state is None:
        raise HTTPException(status_code=500, detail="INSTANCE_STATE_MISSING")
    return state


async def require_initialized(
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> InstanceState:
    if state.initialized_at is None:
        raise HTTPException(status_code=409, detail="SETUP_REQUIRED")
    return state


async def require_uninitialized(
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> InstanceState:
    if state.initialized_at is not None:
        raise HTTPException(status_code=409, detail="SETUP_ALREADY_COMPLETE")
    return state
```

`api/src/pecunia/api/setup.py`:

```python
from typing import Annotated

from fastapi import APIRouter, Depends

from pecunia.api.deps import get_instance_state
from pecunia.models.instance import InstanceState

router = APIRouter(prefix="/setup", tags=["setup"])


@router.get("/status")
async def setup_status(
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> dict[str, bool]:
    return {"initialized": state.initialized_at is not None}
```

In `api/src/pecunia/main.py`, add the import and include (health include stays):

```python
from pecunia.api.setup import router as setup_router
```

```python
    app.include_router(setup_router, prefix="/api/v1")
```

- [ ] **Step 4: Run the full suite to verify green**

Run: `cd api && uv run pytest -v`
Expected: all pass (test count = previous + 3)

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "feat: setup status endpoint and initialized/uninitialized gates"
```

---

### Task 6: Docker — compose, image, entrypoint, first-boot journey

**Files:**
- Create: `api/Dockerfile`, `api/docker/entrypoint.sh`, `api/src/pecunia/wait_for_db.py`, `docker-compose.yml`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: `alembic upgrade head` (Task 3/4), `pecunia.main:app` (Task 1), `get_settings()` (Task 2).
- Produces: the spec §6 journey — `cp .env.example .env && docker compose up -d` → `http://localhost:8480/api/v1/setup/status`. Plan 08 will re-point the published port at `pecunia-web`.

- [ ] **Step 1: Implement `wait_for_db`** — `api/src/pecunia/wait_for_db.py`

```python
"""Entrypoint step 1: block until PostgreSQL accepts connections (bounded)."""
import asyncio
import sys
import time

import asyncpg

from pecunia.config import get_settings


async def _try_connect(dsn: str) -> None:
    conn = await asyncpg.connect(dsn)
    await conn.close()


def main(timeout_seconds: int = 60) -> None:
    dsn = get_settings().database_url.replace("postgresql+asyncpg://", "postgresql://")
    deadline = time.monotonic() + timeout_seconds
    attempt = 0
    while True:
        attempt += 1
        try:
            asyncio.run(_try_connect(dsn))
            print(f"pecunia: database ready (attempt {attempt})", flush=True)
            return
        except Exception as exc:  # noqa: BLE001 — any failure means "not ready yet"
            if time.monotonic() > deadline:
                print(f"pecunia: database unreachable after {timeout_seconds}s: {exc}", file=sys.stderr)
                sys.exit(1)
            print(f"pecunia: waiting for database ({type(exc).__name__})", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Implement entrypoint** — `api/docker/entrypoint.sh`

```sh
#!/bin/sh
set -e

echo "pecunia: starting"
python -m pecunia.wait_for_db
echo "pecunia: running migrations"
alembic upgrade head
echo "pecunia: launching api"
exec uvicorn pecunia.main:app --host 0.0.0.0 --port 8000
```

- [ ] **Step 3: Implement image** — `api/Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml ./
COPY src ./src
COPY alembic.ini ./
COPY alembic ./alembic
RUN uv pip install --system --no-cache .

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 4: Implement compose** — `docker-compose.yml`

```yaml
services:
  pecunia-db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${PECUNIA_DB_USER:-pecunia}
      POSTGRES_PASSWORD: ${PECUNIA_DB_PASSWORD:-pecunia}
      POSTGRES_DB: ${PECUNIA_DB_NAME:-pecunia}
    volumes:
      - pecunia_db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${PECUNIA_DB_USER:-pecunia} -d ${PECUNIA_DB_NAME:-pecunia}"]
      interval: 5s
      timeout: 3s
      retries: 12

  pecunia-api:
    build: ./api
    depends_on:
      pecunia-db:
        condition: service_healthy
    environment:
      PECUNIA_DATABASE_URL: postgresql+asyncpg://${PECUNIA_DB_USER:-pecunia}:${PECUNIA_DB_PASSWORD:-pecunia}@pecunia-db:5432/${PECUNIA_DB_NAME:-pecunia}
      PECUNIA_SECRET_KEY: ${PECUNIA_SECRET_KEY:-}
      PECUNIA_CONFIG_DIR: /data/config
    volumes:
      - pecunia_config:/data/config
      - pecunia_files:/data/files
    ports:
      # Published directly until pecunia-web lands (Plan 08).
      - "${PECUNIA_PORT:-8480}:8000"

volumes:
  pecunia_db_data:
  pecunia_config:
  pecunia_files:
```

- [ ] **Step 5: Implement `.env.example` and `README.md`**

`.env.example`:

```bash
# Pecunia — copy to .env and start: docker compose up -d
# Every value below is optional; the defaults just work.

# Port Pecunia is served on
PECUNIA_PORT=8480

# Leave empty: Pecunia generates a strong key on first boot and persists it.
# If you set one, use 32+ random characters — weak values refuse to start.
PECUNIA_SECRET_KEY=

# Internal database credentials (not exposed outside the compose network)
PECUNIA_DB_USER=pecunia
PECUNIA_DB_PASSWORD=pecunia
PECUNIA_DB_NAME=pecunia
```

`README.md`:

```markdown
# Pecunia

Your financial life. Yours. Self-hosted personal finance.

## Quickstart

​```bash
cp .env.example .env
docker compose up -d
​```

Then open http://localhost:8480 — an uninitialized instance greets you with
the setup wizard. (Until the web UI lands, check the API directly:
`curl localhost:8480/api/v1/setup/status`.)

## Development

​```bash
cd api && uv sync && uv run pytest   # tests need Docker (throwaway Postgres)
​```

Design docs live in `docs/superpowers/specs/`.
```

(Remove the zero-width escapes around the inner code fences when writing the real file — they are only here to nest fences in this plan.)

- [ ] **Step 6: Verify the first-boot journey end to end**

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs pecunia-api
```

Expected log lines in order: `pecunia: starting` → `database ready` → `running migrations` → `Running upgrade  -> 0001` → `launching api` → uvicorn startup.

```bash
curl -s localhost:8480/api/v1/setup/status
```

Expected: `{"initialized":false}`

```bash
docker compose restart pecunia-api && sleep 5 && docker compose logs --tail 20 pecunia-api
```

Expected: boots clean again (migrations no-op — idempotent), same status. Then stop (volumes persist):

```bash
docker compose down
```

- [ ] **Step 7: Commit**

```bash
git add api docker-compose.yml .env.example README.md
git commit -m "feat: docker compose first-boot — wait, migrate, seed, serve"
```

---

## Self-review notes

- **Spec coverage (this plan's slice):** §6 entrypoint steps 1–5 → Task 6 (secret step lives in lifespan via Task 2); D4 detection + gates → Tasks 4–5; D6 zero-infra → no new services; test harness on real Postgres → Task 3. Initialize/auth/audit are Plans 02–03 by design.
- **Type consistency:** `create_app()` (T1) reused by conftest (T3) and tests (T5); `get_db` name consistent across `db.py`/`deps.py`/conftest override; gate detail strings match spec D4 exactly.
- **Known deviation:** none. The spec's `schema_version` column on `instance_state` is intentionally omitted — Alembic's `alembic_version` table is that fact's single source of truth (noted here as the record).
