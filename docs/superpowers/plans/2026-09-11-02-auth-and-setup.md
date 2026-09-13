# Plan 02 — Auth & Setup Initialize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec D1/D2/D4/D7 end to end: identity tables (users, workspaces, memberships), Argon2id passwords, HS256 access JWTs with a key ring, rotating refresh tokens with reuse detection, the full `/api/v1/auth/*` surface, and the atomic race-safe `POST /api/v1/setup/initialize` with auto-login.

**Architecture:** Service layer (`AuthService`, `initialize_instance`) owns all business logic against `AsyncSession`; thin FastAPI routers translate HTTP ↔ services and own commits/cookies; `get_current_user` verifies bearer JWTs statelessly plus a 30s in-process session-liveness cache. Sessions are modeled as rotation *families*: the JWT `sid` claim is the `family_id`, each refresh inserts a new row in the family, and revocation marks the whole family.

**Tech Stack:** adds `argon2-cffi` (passwords), `pyjwt` (JWT), `email-validator` (pydantic `EmailStr`), and dev-only `asgi-lifespan` (lifespan-running tests). Nothing else — no Redis, no rate-limit middleware packages.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-pecunia-v1-design.md` — D1, D2, D4, D7 are the authority. Deviations require a spec update in the same change.
- Refresh tokens: opaque, 256-bit, stored **only** as SHA-256 hashes; rotation on every use; reuse of a superseded/revoked token revokes the **whole family** (`revoke_reason='reuse_detected'`); absolute expiry 30 days **from login, never extended by rotation**; idle expiry 14 days from last issue.
- Access JWT: HS256, 15-minute TTL, claims `iss="pecunia"`, `sub` (user id), `sid` (family id), `jti`, `iat`, `exp`; `kid` header from the key ring.
- Cookies: refresh token in `pecunia_refresh`; `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`; `Secure` when scheme or `X-Forwarded-Proto` is https. Web clients never receive the refresh token in a response body; native clients (`"client": "native"`) receive it in the body once per issuance and get no cookie.
- Exact HTTP error details (strings are API contract): `401 INVALID_CREDENTIALS` (login failure — uniform, no user enumeration), `429 TOO_MANY_ATTEMPTS`, `401 INVALID_REFRESH_TOKEN`, `401 NOT_AUTHENTICATED`, `401 SESSION_REVOKED`, `403 ORIGIN_MISMATCH`, `403 INVALID_SETUP_TOKEN`, plus Plan 01's `409 SETUP_REQUIRED` / `409 SETUP_ALREADY_COMPLETE`.
- Throttle policy: ≥5 failed attempts for the same email OR same IP within 15 minutes → `429`. Durable (`login_attempts` table), no Redis.
- Argon2id parameters: `time_cost=3, memory_cost=65536 (64 MiB), parallelism=4`. Server-side password rule: 10–128 chars (zxcvbn strength lives in the frontend later).
- D7: every identity object created at initialize: owner user + workspace `"Personal"` + membership `role='owner'` — in the **same transaction** that sets `initialized_at`, guarded by `SELECT … FOR UPDATE` on the `instance_state` singleton.
- Roles enum (DB CHECK): `'owner','admin','member','viewer'`. Clients enum (DB CHECK): `'web','native'`.
- All env vars `PECUNIA_`-prefixed (new: `PECUNIA_SETUP_TOKEN`, optional, default empty = disabled).
- Audit events are **Plan 03** — do not build audit hooks here; services must stay clean enough that Plan 03 can add event publishing without restructuring.
- Python 3.12 (`api/.python-version`), `uv run …` from `api/`, conventional commits, TDD per task, run the full suite once before each commit.
- Test-isolation rule (from Plan 01's final review): every test that touches identity tables must run under the `_pg_clean` fixture chain introduced in Task 2 — no test may leave rows behind.

---

## File Structure (end state of this plan)

```
api/src/pecunia/
├── main.py                      MOD: lifespan owns engine + session cache
├── config.py                    MOD: + setup_token
├── db.py                        (unchanged; lazy fallback kept)
├── device_label.py              NEW: tiny UA → "Firefox · Linux" parser
├── security/
│   ├── __init__.py              NEW (empty)
│   ├── passwords.py             NEW: Argon2id hash/verify
│   ├── tokens.py                NEW: KeyRing, create/decode access JWT
│   └── session_cache.py         NEW: 30s liveness cache
├── services/
│   ├── __init__.py              NEW (empty)
│   ├── auth.py                  NEW: AuthService (login/refresh/logout/…/throttle)
│   └── setup.py                 NEW: initialize_instance()
├── models/
│   ├── __init__.py              MOD: export new models
│   ├── user.py                  NEW: User
│   ├── workspace.py             NEW: Workspace, WorkspaceMembership
│   └── auth_session.py          NEW: AuthSession, LoginAttempt
├── api/
│   ├── deps.py                  MOD: + AuthContext, get_current_user
│   ├── auth.py                  NEW: /auth router + schemas + cookie/origin helpers
│   └── setup.py                 MOD: + POST /setup/initialize
└── alembic/versions/0002_identity_and_auth.py   NEW

api/tests/
├── conftest.py                  MOD: test secret on app fixture; _pg_clean chain; initialized_instance fixture
├── test_lifespan.py             NEW
├── test_migration_0002.py       NEW
├── test_passwords.py            NEW
├── test_tokens.py               NEW
├── test_device_label.py         NEW
├── test_auth_service.py         NEW (login/throttle/session issuance)
├── test_refresh_rotation.py     NEW
├── test_current_user.py         NEW (dependency + cache)
├── test_auth_endpoints.py       NEW
└── test_setup_initialize.py     NEW
```

---

### Task 1: Lifespan owns the engine + lifespan test fixture

**Files:**
- Modify: `api/src/pecunia/main.py`, `api/pyproject.toml` (dev dep `asgi-lifespan`), `api/tests/conftest.py` (app fixture gets a test secret)
- Test: `api/tests/test_lifespan.py`

**Interfaces:**
- Consumes: `resolve_secret_key`, `init_engine` (Plan 01).
- Produces: lifespan initializes `app.state.secret_key` AND the DB engine, and disposes the engine on shutdown; the `app` test fixture always carries `app.state.secret_key = TEST_SECRET_KEY` (importable from conftest as module constant `TEST_SECRET_KEY`, value `"t" * 64`). Later tasks' JWT code reads `request.app.state.secret_key`.

- [ ] **Step 1: Add dev dependency**

In `api/pyproject.toml`, append to the `dev` dependency group list:

```toml
    "asgi-lifespan>=2.1",
```

Run: `cd api && uv sync` — resolves and installs.

- [ ] **Step 2: Write the failing test** — `api/tests/test_lifespan.py`

```python
from asgi_lifespan import LifespanManager

import pecunia.db as db_module
from pecunia.main import create_app


async def test_lifespan_resolves_secret_and_initializes_engine(tmp_path, monkeypatch, pg_url):
    monkeypatch.setenv("PECUNIA_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("PECUNIA_SECRET_KEY", "")
    app = create_app()
    async with LifespanManager(app):
        assert len(app.state.secret_key) == 64
        assert (tmp_path / "secret_key").exists()
        assert db_module._engine is not None
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_lifespan.py -v`
Expected: FAIL — `AssertionError` on `db_module._engine is not None` (lifespan does not init the engine yet). (The secret assertions pass already; that's fine — the failing assertion is the new behavior.)

- [ ] **Step 4: Implement** — replace the lifespan in `api/src/pecunia/main.py`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.secret_key = resolve_secret_key(settings.secret_key, settings.config_dir)
    engine = init_engine()
    yield
    await engine.dispose()
```

with the import added:

```python
from pecunia.db import init_engine
```

- [ ] **Step 5: Give the test app a deterministic secret** — in `api/tests/conftest.py`, add a module-level constant after the imports:

```python
TEST_SECRET_KEY = "t" * 64
```

and in the `app` fixture, immediately after `application = create_app()`:

```python
    application.state.secret_key = TEST_SECRET_KEY
```

(ASGITransport never runs the lifespan; this mirrors what the lifespan does in production so request-time code can rely on `app.state.secret_key`.)

- [ ] **Step 6: Run the full suite**

Run: `cd api && uv run pytest -v`
Expected: 13 passed (12 + the new lifespan test)

- [ ] **Step 7: Commit**

```bash
git add api
git commit -m "feat: lifespan owns engine lifecycle; lifespan-running test fixture"
```

---

### Task 2: Migration 0002 — identity & auth tables, per-test DB cleanup

**Files:**
- Create: `api/alembic/versions/0002_identity_and_auth.py`, `api/src/pecunia/models/user.py`, `api/src/pecunia/models/workspace.py`, `api/src/pecunia/models/auth_session.py`
- Modify: `api/src/pecunia/models/__init__.py`, `api/src/pecunia/models/instance.py` (add `settings` column), `api/tests/conftest.py` (`_pg_clean` chain)
- Test: `api/tests/test_migration_0002.py`

**Interfaces:**
- Produces models (exact names/columns later tasks import from `pecunia.models`): `User(id, email, name, display_name, password_hash, created_at, updated_at)`, `Workspace(id, name, created_at)`, `WorkspaceMembership(workspace_id, user_id, role, joined_at)`, `AuthSession(id, user_id, family_id, token_hash, client, created_at, expires_at, idle_expires_at, last_used_at, superseded_by, revoked_at, revoke_reason, ip, user_agent, device_label)`, `LoginAttempt(id, email_tried, ip, succeeded, occurred_at)`; `InstanceState.settings` (JSONB, nullable).
- Produces fixture: `_pg_clean` — `db`, `app` (and hence `client`) now depend on it; after each test it nulls `instance_state` init fields and deletes identity rows. Every later task's DB tests inherit isolation automatically.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_migration_0002.py`

```python
import uuid

import pytest
import sqlalchemy as sa

from pecunia.models import AuthSession, LoginAttempt, User, Workspace, WorkspaceMembership


async def test_identity_tables_exist_and_email_is_case_insensitive_unique(db):
    db.add(User(id=uuid.uuid4(), email="Owner@Example.com", name="Owner", password_hash="x"))
    await db.commit()
    db.add(User(id=uuid.uuid4(), email="owner@example.COM", name="Dup", password_hash="x"))
    with pytest.raises(sa.exc.IntegrityError):
        await db.commit()
    await db.rollback()


async def test_membership_role_check_constraint(db):
    user = User(id=uuid.uuid4(), email="a@b.c", name="A", password_hash="x")
    ws = Workspace(id=uuid.uuid4(), name="Personal")
    db.add_all([user, ws])
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws.id, user_id=user.id, role="king"))
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_auth_session_client_check_and_token_hash_unique(db):
    user = User(id=uuid.uuid4(), email="a@b.c", name="A", password_hash="x")
    db.add(user)
    await db.flush()
    row = dict(
        user_id=user.id, family_id=uuid.uuid4(), token_hash=b"h" * 32,
        expires_at=sa.func.now(), idle_expires_at=sa.func.now(),
    )
    db.add(AuthSession(id=uuid.uuid4(), client="web", **row))
    await db.flush()
    db.add(AuthSession(id=uuid.uuid4(), client="carrier-pigeon", **row | {"token_hash": b"i" * 32}))
    with pytest.raises(sa.exc.IntegrityError):
        await db.flush()
    await db.rollback()


async def test_cleanup_fixture_resets_state_between_tests(db):
    # Runs after the tests above in file order: their rows must be gone.
    for model in (User, Workspace, WorkspaceMembership, AuthSession, LoginAttempt):
        count = (await db.execute(sa.select(sa.func.count()).select_from(model))).scalar_one()
        assert count == 0, f"{model.__name__} not cleaned"
    state = (await db.execute(sa.text("SELECT initialized_at, owner_user_id, settings FROM instance_state WHERE id = 1"))).one()
    assert state == (None, None, None)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_migration_0002.py -v`
Expected: FAIL — `ImportError` (models don't exist)

- [ ] **Step 3: Implement models**

`api/src/pecunia/models/user.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Text, Uuid

from pecunia.models.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    email: Mapped[str] = mapped_column(CITEXT(), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str | None] = mapped_column(Text)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
```

`api/src/pecunia/models/workspace.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Text, Uuid

from pecunia.models.base import Base


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )


class WorkspaceMembership(Base):
    __tablename__ = "workspace_memberships"
    __table_args__ = (
        CheckConstraint("role IN ('owner','admin','member','viewer')", name="role_valid"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
```

`api/src/pecunia/models/auth_session.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, Identity, text
from sqlalchemy.dialects.postgresql import CITEXT, INET
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import Boolean, DateTime, LargeBinary, Text, Uuid

from pecunia.models.base import Base


class AuthSession(Base):
    """One issued refresh token; a login session is the family of rotations."""

    __tablename__ = "auth_sessions"
    __table_args__ = (CheckConstraint("client IN ('web','native')", name="client_valid"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    family_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True, nullable=False)
    client: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    idle_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(INET())
    user_agent: Mapped[str | None] = mapped_column(Text)
    device_label: Mapped[str | None] = mapped_column(Text)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    email_tried: Mapped[str] = mapped_column(CITEXT(), nullable=False)
    ip: Mapped[str | None] = mapped_column(INET())
    succeeded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False, index=True
    )
```

In `api/src/pecunia/models/instance.py`, add after the `owner_user_id` column:

```python
    settings: Mapped[dict | None] = mapped_column(JSONB)
```

with the import added at the top:

```python
from sqlalchemy.dialects.postgresql import JSONB
```

Replace `api/src/pecunia/models/__init__.py`:

```python
from pecunia.models.auth_session import AuthSession, LoginAttempt
from pecunia.models.base import Base
from pecunia.models.instance import InstanceState
from pecunia.models.user import User
from pecunia.models.workspace import Workspace, WorkspaceMembership

__all__ = [
    "AuthSession",
    "Base",
    "InstanceState",
    "LoginAttempt",
    "User",
    "Workspace",
    "WorkspaceMembership",
]
```

- [ ] **Step 4: Implement migration** — `api/alembic/versions/0002_identity_and_auth.py`

```python
"""identity and auth tables

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-11
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, INET, JSONB

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("email", CITEXT(), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("display_name", sa.Text, nullable=True),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    op.create_table(
        "workspaces",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        "workspace_memberships",
        sa.Column("workspace_id", sa.Uuid, sa.ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.Text, nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("role IN ('owner','admin','member','viewer')", name="ck_workspace_memberships_role_valid"),
    )

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("family_id", sa.Uuid, nullable=False),
        sa.Column("token_hash", sa.LargeBinary, nullable=False),
        sa.Column("client", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("idle_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("superseded_by", sa.Uuid, nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoke_reason", sa.Text, nullable=True),
        sa.Column("ip", INET(), nullable=True),
        sa.Column("user_agent", sa.Text, nullable=True),
        sa.Column("device_label", sa.Text, nullable=True),
        sa.UniqueConstraint("token_hash", name="uq_auth_sessions_token_hash"),
        sa.CheckConstraint("client IN ('web','native')", name="ck_auth_sessions_client_valid"),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_family_id", "auth_sessions", ["family_id"])

    op.create_table(
        "login_attempts",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("email_tried", CITEXT(), nullable=False),
        sa.Column("ip", INET(), nullable=True),
        sa.Column("succeeded", sa.Boolean, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_login_attempts_occurred_at", "login_attempts", ["occurred_at"])
    op.create_index("ix_login_attempts_email_time", "login_attempts", ["email_tried", "occurred_at"])
    op.create_index("ix_login_attempts_ip_time", "login_attempts", ["ip", "occurred_at"])

    op.add_column("instance_state", sa.Column("settings", JSONB(), nullable=True))
    op.create_foreign_key(
        "fk_instance_state_owner_user_id_users", "instance_state", "users", ["owner_user_id"], ["id"]
    )


def downgrade() -> None:
    op.drop_constraint("fk_instance_state_owner_user_id_users", "instance_state", type_="foreignkey")
    op.drop_column("instance_state", "settings")
    op.drop_table("login_attempts")
    op.drop_table("auth_sessions")
    op.drop_table("workspace_memberships")
    op.drop_table("workspaces")
    op.drop_table("users")
```

- [ ] **Step 5: Implement the cleanup chain** — in `api/tests/conftest.py`:

Add this fixture after `engine`:

```python
@pytest.fixture
async def _pg_clean(engine):
    """Reset identity/auth state after each test (order respects FKs)."""
    yield
    async with engine.begin() as conn:
        await conn.execute(
            sa.text("UPDATE instance_state SET initialized_at = NULL, owner_user_id = NULL, settings = NULL WHERE id = 1")
        )
        for table in ("auth_sessions", "login_attempts", "workspace_memberships", "workspaces", "users"):
            await conn.execute(sa.text(f"DELETE FROM {table}"))
```

Add `import sqlalchemy as sa` to conftest's imports. Change the signatures of the `db` and `app` fixtures to depend on it:

```python
@pytest.fixture
async def db(engine, _pg_clean):
```

```python
@pytest.fixture
async def app(engine, _pg_clean):
```

- [ ] **Step 6: Run tests to verify green**

Run: `cd api && uv run pytest tests/test_migration_0002.py -v` — Expected: 4 passed.
Then: `cd api && uv run pytest -v` — Expected: 17 passed (13 + 4).

- [ ] **Step 7: Commit**

```bash
git add api
git commit -m "feat: identity and auth tables (migration 0002) with per-test db cleanup"
```

---

### Task 3: Argon2id password hashing

**Files:**
- Create: `api/src/pecunia/security/__init__.py` (empty), `api/src/pecunia/security/passwords.py`
- Modify: `api/pyproject.toml` (add `argon2-cffi`)
- Test: `api/tests/test_passwords.py`

**Interfaces:**
- Produces: `pecunia.security.passwords.hash_password(password: str) -> str` and `verify_password(password: str, password_hash: str) -> bool` (never raises on bad input — returns False).

- [ ] **Step 1: Add dependency** — in `api/pyproject.toml` main `dependencies`, append:

```toml
    "argon2-cffi>=23.1",
```

Run: `cd api && uv sync`

- [ ] **Step 2: Write the failing tests** — `api/tests/test_passwords.py`

```python
from pecunia.security.passwords import hash_password, verify_password


def test_hash_and_verify_roundtrip():
    h = hash_password("correct horse battery staple")
    assert h.startswith("$argon2id$")
    assert verify_password("correct horse battery staple", h) is True


def test_wrong_password_fails():
    h = hash_password("correct horse battery staple")
    assert verify_password("wrong password entirely", h) is False


def test_garbage_hash_returns_false_not_raise():
    assert verify_password("anything", "not-a-hash") is False


def test_hashes_are_salted_unique():
    assert hash_password("same input") != hash_password("same input")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_passwords.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pecunia.security'`

- [ ] **Step 4: Implement** — `api/src/pecunia/security/passwords.py`

```python
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False
```

(`api/src/pecunia/security/__init__.py` is an empty file.)

- [ ] **Step 5: Run the full suite, then commit**

Run: `cd api && uv run pytest -v` — Expected: 21 passed.

```bash
git add api
git commit -m "feat: argon2id password hashing"
```

---

### Task 4: Access-token module (KeyRing + HS256 JWT)

**Files:**
- Create: `api/src/pecunia/security/tokens.py`
- Modify: `api/pyproject.toml` (add `pyjwt`)
- Test: `api/tests/test_tokens.py`

**Interfaces:**
- Produces: `pecunia.security.tokens.KeyRing` (`KeyRing.single(secret) -> KeyRing`; `.keys: dict[str, str]`, `.current: str`), `ACCESS_TTL` (timedelta, 15 min), `TokenError`, `create_access_token(*, user_id: uuid.UUID, family_id: uuid.UUID, ring: KeyRing, now: datetime | None = None, ttl: timedelta = ACCESS_TTL) -> str`, `decode_access_token(token: str, ring: KeyRing) -> dict` (validated claims; raises `TokenError` on any problem).

- [ ] **Step 1: Add dependency** — in `api/pyproject.toml` main `dependencies`, append:

```toml
    "pyjwt>=2.9",
```

Run: `cd api && uv sync`

- [ ] **Step 2: Write the failing tests** — `api/tests/test_tokens.py`

```python
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from pecunia.security.tokens import (
    ACCESS_TTL,
    KeyRing,
    TokenError,
    create_access_token,
    decode_access_token,
)

RING = KeyRing.single("s" * 64)
USER = uuid.uuid4()
FAMILY = uuid.uuid4()


def test_roundtrip_claims():
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=RING)
    claims = decode_access_token(token, RING)
    assert claims["iss"] == "pecunia"
    assert claims["sub"] == str(USER)
    assert claims["sid"] == str(FAMILY)
    assert uuid.UUID(claims["jti"])
    assert claims["exp"] - claims["iat"] == int(ACCESS_TTL.total_seconds())


def test_expired_token_rejected():
    old = datetime.now(UTC) - timedelta(hours=1)
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=RING, now=old)
    with pytest.raises(TokenError):
        decode_access_token(token, RING)


def test_wrong_key_rejected():
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=RING)
    with pytest.raises(TokenError):
        decode_access_token(token, KeyRing.single("x" * 64))


def test_unknown_kid_rejected():
    other = KeyRing({"9": "y" * 64}, "9")
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=other)
    with pytest.raises(TokenError):
        decode_access_token(token, RING)


def test_key_rotation_old_key_still_verifies():
    old_ring = KeyRing.single("s" * 64)                       # kid "1"
    token = create_access_token(user_id=USER, family_id=FAMILY, ring=old_ring)
    rotated = KeyRing({"1": "s" * 64, "2": "n" * 64}, "2")    # new current, old kept
    assert decode_access_token(token, rotated)["sub"] == str(USER)


def test_garbage_rejected():
    with pytest.raises(TokenError):
        decode_access_token("not.a.jwt", RING)
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_tokens.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pecunia.security.tokens'`

- [ ] **Step 4: Implement** — `api/src/pecunia/security/tokens.py`

```python
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

ISSUER = "pecunia"
ALGORITHM = "HS256"
ACCESS_TTL = timedelta(minutes=15)


class TokenError(Exception):
    """Any reason an access token is unusable (malformed, expired, bad key…)."""


@dataclass(frozen=True)
class KeyRing:
    keys: dict[str, str]
    current: str

    @classmethod
    def single(cls, secret: str) -> "KeyRing":
        return cls(keys={"1": secret}, current="1")


def create_access_token(
    *,
    user_id: uuid.UUID,
    family_id: uuid.UUID,
    ring: KeyRing,
    now: datetime | None = None,
    ttl: timedelta = ACCESS_TTL,
) -> str:
    now = now or datetime.now(UTC)
    claims = {
        "iss": ISSUER,
        "sub": str(user_id),
        "sid": str(family_id),
        "jti": str(uuid.uuid4()),
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    return jwt.encode(
        claims, ring.keys[ring.current], algorithm=ALGORITHM, headers={"kid": ring.current}
    )


def decode_access_token(token: str, ring: KeyRing) -> dict:
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
    key = ring.keys.get(kid or "")
    if key is None:
        raise TokenError("unknown key id")
    try:
        return jwt.decode(
            token,
            key,
            algorithms=[ALGORITHM],
            issuer=ISSUER,
            options={"require": ["exp", "iat", "iss", "sub", "sid", "jti"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
```

- [ ] **Step 5: Run the full suite, then commit**

Run: `cd api && uv run pytest -v` — Expected: 27 passed.

```bash
git add api
git commit -m "feat: hs256 access tokens with key ring"
```

---

### Task 5: Device label + AuthService (session issuance, login, throttling)

**Files:**
- Create: `api/src/pecunia/device_label.py`, `api/src/pecunia/services/__init__.py` (empty), `api/src/pecunia/services/auth.py`
- Modify: `api/tests/conftest.py` (add `user_factory` fixture)
- Test: `api/tests/test_device_label.py`, `api/tests/test_auth_service.py`

**Interfaces:**
- Consumes: models (Task 2), `hash_password`/`verify_password` (Task 3).
- Produces: `pecunia.device_label.device_label(user_agent: str | None) -> str | None`; `pecunia.services.auth` exports `AuthService(db)`, constants `REFRESH_ABSOLUTE` (30d) / `REFRESH_IDLE` (14d) / `THROTTLE_WINDOW` (15min) / `THROTTLE_MAX_FAILURES` (5), errors `InvalidCredentialsError` / `ThrottledError`, helper `hash_refresh_token(token: str) -> bytes`. Methods this task ships: `create_session(user, *, client, ip, user_agent, family_id=None, absolute_expires_at=None) -> tuple[AuthSession, str]` and `login(*, email, password, client, ip, user_agent) -> tuple[User, AuthSession, str]` and `_check_throttle`. Conftest gains `user_factory` (async factory fixture; defaults `email="owner@example.com"`, `password="correct horse battery staple"`).

- [ ] **Step 1: Write the failing tests**

`api/tests/test_device_label.py`:

```python
from pecunia.device_label import device_label

FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
EDGE_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"


def test_firefox_linux():
    assert device_label(FIREFOX_LINUX) == "Firefox · Linux"


def test_chrome_windows():
    assert device_label(CHROME_WIN) == "Chrome · Windows"


def test_safari_iphone():
    assert device_label(SAFARI_IPHONE) == "Safari · iOS"


def test_edge_beats_chrome_token():
    assert device_label(EDGE_MAC) == "Edge · macOS"


def test_none_and_empty():
    assert device_label(None) is None
    assert device_label("") is None


def test_unknown_agent_returns_none():
    assert device_label("curl/8.9.0") is None
```

`api/tests/test_auth_service.py`:

```python
import uuid
from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from pecunia.models import AuthSession, LoginAttempt
from pecunia.services.auth import (
    REFRESH_ABSOLUTE,
    THROTTLE_MAX_FAILURES,
    AuthService,
    InvalidCredentialsError,
    ThrottledError,
    hash_refresh_token,
)

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"


async def test_login_success_issues_session(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    logged_user, session, refresh_token = await svc.login(
        email="owner@example.com", password="correct horse battery staple",
        client="web", ip="127.0.0.1", user_agent=UA,
    )
    assert logged_user.id == user.id
    assert session.family_id is not None
    assert session.device_label == "Firefox · Linux"
    # The raw token is never stored — only its sha256.
    stored = (await db.execute(sa.select(AuthSession.token_hash))).scalar_one()
    assert stored == hash_refresh_token(refresh_token)
    assert refresh_token not in str(stored)
    remaining = session.expires_at - datetime.now(UTC)
    assert timedelta(days=29) < remaining <= REFRESH_ABSOLUTE


async def test_login_wrong_password_uniform_error_and_recorded(db, user_factory):
    await user_factory()
    svc = AuthService(db)
    with pytest.raises(InvalidCredentialsError):
        await svc.login(email="owner@example.com", password="wrong", client="web", ip="127.0.0.1", user_agent=UA)
    attempt = (await db.execute(sa.select(LoginAttempt))).scalar_one()
    assert attempt.succeeded is False


async def test_login_unknown_email_same_error(db):
    svc = AuthService(db)
    with pytest.raises(InvalidCredentialsError):
        await svc.login(email="ghost@example.com", password="x", client="web", ip="127.0.0.1", user_agent=UA)


async def test_throttle_after_max_failures(db, user_factory):
    await user_factory()
    svc = AuthService(db)
    for _ in range(THROTTLE_MAX_FAILURES):
        with pytest.raises(InvalidCredentialsError):
            await svc.login(email="owner@example.com", password="wrong", client="web", ip="10.0.0.9", user_agent=UA)
    with pytest.raises(ThrottledError):
        await svc.login(email="owner@example.com", password="correct horse battery staple", client="web", ip="10.0.0.9", user_agent=UA)


async def test_throttle_counts_by_ip_across_emails(db):
    svc = AuthService(db)
    for i in range(THROTTLE_MAX_FAILURES):
        with pytest.raises(InvalidCredentialsError):
            await svc.login(email=f"probe{i}@example.com", password="x", client="web", ip="10.0.0.9", user_agent=UA)
    with pytest.raises(ThrottledError):
        await svc.login(email="fresh@example.com", password="x", client="web", ip="10.0.0.9", user_agent=UA)


async def test_old_failures_outside_window_do_not_throttle(db, user_factory):
    await user_factory()
    svc = AuthService(db)
    for _ in range(THROTTLE_MAX_FAILURES):
        with pytest.raises(InvalidCredentialsError):
            await svc.login(email="owner@example.com", password="wrong", client="web", ip="10.0.0.9", user_agent=UA)
    await db.execute(sa.text("UPDATE login_attempts SET occurred_at = occurred_at - interval '1 hour'"))
    user, session, token = await svc.login(
        email="owner@example.com", password="correct horse battery staple",
        client="web", ip="10.0.0.9", user_agent=UA,
    )
    assert session is not None
```

- [ ] **Step 2: Add the `user_factory` fixture** — in `api/tests/conftest.py` (before running the failing tests, so the failure is the missing module, not the missing fixture). Add `import uuid` to conftest imports, then:

```python
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_device_label.py tests/test_auth_service.py -v`
Expected: FAIL — `ModuleNotFoundError` for `pecunia.device_label` / `pecunia.services.auth`

- [ ] **Step 4: Implement**

`api/src/pecunia/device_label.py`:

```python
_BROWSERS = [
    ("Firefox/", "Firefox"),
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
]
_SYSTEMS = [
    ("Windows", "Windows"),
    ("Android", "Android"),
    ("iPhone", "iOS"),
    ("iPad", "iPadOS"),
    ("Mac OS X", "macOS"),
    ("Linux", "Linux"),
]


def device_label(user_agent: str | None) -> str | None:
    """Best-effort 'Firefox · Linux' label for the sessions UI. Display only —
    never a security signal. Order matters: Edge UAs contain 'Chrome/', Chrome
    UAs contain 'Safari/', iPhone UAs contain 'Mac OS X', Android contains 'Linux'."""
    if not user_agent:
        return None
    browser = next((name for token, name in _BROWSERS if token in user_agent), None)
    system = next((name for token, name in _SYSTEMS if token in user_agent), None)
    if browser and system:
        return f"{browser} · {system}"
    return browser or system
```

`api/src/pecunia/services/__init__.py` — empty file.

`api/src/pecunia/services/auth.py`:

```python
import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.device_label import device_label
from pecunia.models import AuthSession, LoginAttempt, User
from pecunia.security.passwords import verify_password

REFRESH_ABSOLUTE = timedelta(days=30)
REFRESH_IDLE = timedelta(days=14)
THROTTLE_WINDOW = timedelta(minutes=15)
THROTTLE_MAX_FAILURES = 5


class InvalidCredentialsError(Exception):
    pass


class ThrottledError(Exception):
    pass


def hash_refresh_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def _new_refresh_token() -> tuple[str, bytes]:
    token = secrets.token_urlsafe(32)
    return token, hash_refresh_token(token)


class AuthService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_session(
        self,
        user: User,
        *,
        client: str,
        ip: str | None,
        user_agent: str | None,
        family_id: uuid.UUID | None = None,
        absolute_expires_at: datetime | None = None,
    ) -> tuple[AuthSession, str]:
        now = datetime.now(UTC)
        token, token_hash = _new_refresh_token()
        session = AuthSession(
            id=uuid.uuid4(),
            user_id=user.id,
            family_id=family_id or uuid.uuid4(),
            token_hash=token_hash,
            client=client,
            expires_at=absolute_expires_at or (now + REFRESH_ABSOLUTE),
            idle_expires_at=now + REFRESH_IDLE,
            ip=ip,
            user_agent=user_agent,
            device_label=device_label(user_agent),
        )
        self.db.add(session)
        await self.db.flush()
        return session, token

    async def login(
        self, *, email: str, password: str, client: str, ip: str | None, user_agent: str | None
    ) -> tuple[User, AuthSession, str]:
        await self._check_throttle(email=email, ip=ip)
        result = await self.db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        ok = user is not None and verify_password(password, user.password_hash)
        self.db.add(LoginAttempt(email_tried=email, ip=ip, succeeded=ok))
        await self.db.flush()
        if not ok:
            raise InvalidCredentialsError()
        session, refresh_token = await self.create_session(
            user, client=client, ip=ip, user_agent=user_agent
        )
        return user, session, refresh_token

    async def _check_throttle(self, *, email: str, ip: str | None) -> None:
        cutoff = datetime.now(UTC) - THROTTLE_WINDOW
        conditions = [LoginAttempt.email_tried == email]
        if ip is not None:
            conditions.append(LoginAttempt.ip == ip)
        stmt = (
            select(func.count())
            .select_from(LoginAttempt)
            .where(
                LoginAttempt.occurred_at >= cutoff,
                LoginAttempt.succeeded.is_(False),
                or_(*conditions),
            )
        )
        failures = (await self.db.execute(stmt)).scalar_one()
        if failures >= THROTTLE_MAX_FAILURES:
            raise ThrottledError()
```

- [ ] **Step 5: Run tests to verify green, then full suite**

Run: `cd api && uv run pytest tests/test_device_label.py tests/test_auth_service.py -v` — Expected: 12 passed.
Then: `cd api && uv run pytest -v` — Expected: 39 passed.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "feat: auth service with login, throttling, and device labels"
```

---

### Task 6: Refresh rotation, reuse detection, revocation, session listing

**Files:**
- Modify: `api/src/pecunia/services/auth.py`
- Test: `api/tests/test_refresh_rotation.py`

**Interfaces:**
- Consumes: everything Task 5 produced.
- Produces (appended to `pecunia.services.auth`): error `InvalidRefreshTokenError`; `AuthService` methods `refresh(token, *, ip, user_agent) -> tuple[User, AuthSession, str]`, `revoke_family(family_id, *, reason) -> None`, `logout_all(user_id) -> None`, `list_sessions(user_id) -> list[AuthSession]` (active family heads, newest first), `revoke_user_family(user_id, family_id) -> bool`, `is_family_active(family_id) -> bool`. Revoke reasons used (API contract with Plan 03 audit): `'logout'`, `'logout_all'`, `'user_revoked'`, `'reuse_detected'`.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_refresh_rotation.py`

```python
import uuid

import pytest
import sqlalchemy as sa

from pecunia.models import AuthSession
from pecunia.services.auth import AuthService, InvalidRefreshTokenError

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"


async def _login(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    _, session, token = await svc.login(
        email="owner@example.com", password="correct horse battery staple",
        client="web", ip="127.0.0.1", user_agent=UA,
    )
    return svc, user, session, token


async def test_refresh_rotates_within_family_and_keeps_absolute_expiry(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    _, second, new_token = await svc.refresh(token, ip="127.0.0.1", user_agent=UA)
    assert new_token != token
    assert second.family_id == first.family_id
    assert second.expires_at == first.expires_at  # absolute cap never extended
    await db.refresh(first)
    assert first.superseded_by == second.id
    assert first.last_used_at is not None


async def test_reuse_of_rotated_token_revokes_whole_family(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await svc.refresh(token, ip="127.0.0.1", user_agent=UA)
    with pytest.raises(InvalidRefreshTokenError):
        await svc.refresh(token, ip="6.6.6.6", user_agent=UA)
    rows = list((await db.execute(sa.select(AuthSession).where(AuthSession.family_id == first.family_id))).scalars())
    assert len(rows) == 2
    assert all(r.revoked_at is not None and r.revoke_reason == "reuse_detected" for r in rows)
    assert await svc.is_family_active(first.family_id) is False


async def test_unknown_token_rejected(db):
    with pytest.raises(InvalidRefreshTokenError):
        await AuthService(db).refresh("no-such-token", ip=None, user_agent=None)


async def test_absolute_expiry_rejects(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await db.execute(sa.text("UPDATE auth_sessions SET expires_at = now() - interval '1 minute'"))
    with pytest.raises(InvalidRefreshTokenError):
        await svc.refresh(token, ip=None, user_agent=None)


async def test_idle_expiry_rejects(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await db.execute(sa.text("UPDATE auth_sessions SET idle_expires_at = now() - interval '1 minute'"))
    with pytest.raises(InvalidRefreshTokenError):
        await svc.refresh(token, ip=None, user_agent=None)


async def test_logout_all_revokes_every_family(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    for _ in range(2):
        await svc.login(email="owner@example.com", password="correct horse battery staple",
                        client="web", ip="127.0.0.1", user_agent=UA)
    await svc.logout_all(user.id)
    assert await db.scalar(
        sa.select(sa.func.count()).select_from(AuthSession).where(AuthSession.revoked_at.is_(None))
    ) == 0


async def test_list_sessions_returns_active_family_heads_only(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await svc.refresh(token, ip="127.0.0.1", user_agent=UA)  # rotates: 2 rows, 1 head
    await svc.login(email="owner@example.com", password="correct horse battery staple",
                    client="native", ip=None, user_agent=None)
    heads = await svc.list_sessions(user.id)
    assert len(heads) == 2
    assert all(h.superseded_by is None and h.revoked_at is None for h in heads)


async def test_revoke_user_family_checks_ownership(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    stranger_id = uuid.uuid4()
    assert await svc.revoke_user_family(stranger_id, first.family_id) is False
    assert await svc.revoke_user_family(user.id, first.family_id) is True
    assert await svc.is_family_active(first.family_id) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_refresh_rotation.py -v`
Expected: FAIL — `ImportError: cannot import name 'InvalidRefreshTokenError'`

- [ ] **Step 3: Implement** — in `api/src/pecunia/services/auth.py`:

Add `update` to the sqlalchemy import line:

```python
from sqlalchemy import func, or_, select, update
```

Add after `ThrottledError`:

```python
class InvalidRefreshTokenError(Exception):
    pass
```

Append these methods to `AuthService`:

```python
    async def refresh(
        self, token: str, *, ip: str | None, user_agent: str | None
    ) -> tuple[User, AuthSession, str]:
        token_hash = hash_refresh_token(token)
        result = await self.db.execute(
            select(AuthSession).where(AuthSession.token_hash == token_hash)
        )
        session = result.scalar_one_or_none()
        if session is None:
            raise InvalidRefreshTokenError()
        now = datetime.now(UTC)
        if session.revoked_at is not None or session.superseded_by is not None:
            # Replay of a dead token is evidence of theft: kill the family.
            await self.revoke_family(session.family_id, reason="reuse_detected")
            await self.db.flush()
            raise InvalidRefreshTokenError()
        if session.expires_at <= now or session.idle_expires_at <= now:
            raise InvalidRefreshTokenError()
        user = await self.db.get(User, session.user_id)
        if user is None:
            raise InvalidRefreshTokenError()
        new_session, new_token = await self.create_session(
            user,
            client=session.client,
            ip=ip,
            user_agent=user_agent,
            family_id=session.family_id,
            absolute_expires_at=session.expires_at,
        )
        session.superseded_by = new_session.id
        session.last_used_at = now
        await self.db.flush()
        return user, new_session, new_token

    async def revoke_family(self, family_id: uuid.UUID, *, reason: str) -> None:
        await self.db.execute(
            update(AuthSession)
            .where(AuthSession.family_id == family_id, AuthSession.revoked_at.is_(None))
            .values(revoked_at=func.now(), revoke_reason=reason)
        )

    async def logout_all(self, user_id: uuid.UUID) -> None:
        await self.db.execute(
            update(AuthSession)
            .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
            .values(revoked_at=func.now(), revoke_reason="logout_all")
        )

    async def list_sessions(self, user_id: uuid.UUID) -> list[AuthSession]:
        now = datetime.now(UTC)
        stmt = (
            select(AuthSession)
            .where(
                AuthSession.user_id == user_id,
                AuthSession.superseded_by.is_(None),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.idle_expires_at > now,
            )
            .order_by(AuthSession.created_at.desc())
        )
        return list((await self.db.execute(stmt)).scalars())

    async def revoke_user_family(self, user_id: uuid.UUID, family_id: uuid.UUID) -> bool:
        count = await self.db.scalar(
            select(func.count())
            .select_from(AuthSession)
            .where(AuthSession.family_id == family_id, AuthSession.user_id == user_id)
        )
        if not count:
            return False
        await self.revoke_family(family_id, reason="user_revoked")
        return True

    async def is_family_active(self, family_id: uuid.UUID) -> bool:
        now = datetime.now(UTC)
        count = await self.db.scalar(
            select(func.count())
            .select_from(AuthSession)
            .where(
                AuthSession.family_id == family_id,
                AuthSession.superseded_by.is_(None),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
            )
        )
        return bool(count)
```

Note: `revoke_family` mutates rows via a bulk UPDATE; ORM objects already loaded in the session may be stale afterwards — tests re-select or `db.refresh()` as needed. `session.expire_all()` is not required for the assertions written here except where the tests already call `db.refresh(...)` or re-select. If SQLAlchemy raises stale-data warnings in the reuse test, add `await self.db.execute(...)` → `.execution_options(synchronize_session=False)` to the two bulk updates — document in your report if you needed it.

- [ ] **Step 4: Run tests to verify green, then full suite**

Run: `cd api && uv run pytest tests/test_refresh_rotation.py -v` — Expected: 8 passed.
Then: `cd api && uv run pytest -v` — Expected: 47 passed.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "feat: refresh rotation with reuse detection and family revocation"
```

---

### Task 7: Session-liveness cache + `get_current_user`

**Files:**
- Create: `api/src/pecunia/security/session_cache.py`
- Modify: `api/src/pecunia/main.py` (lifespan creates the cache), `api/src/pecunia/api/deps.py`
- Test: `api/tests/test_current_user.py`

**Interfaces:**
- Consumes: `KeyRing`/`decode_access_token` (Task 4), `AuthService.is_family_active` (Task 6), `app.state.secret_key` (Task 1).
- Produces: `pecunia.security.session_cache.SessionCache(ttl_seconds=30.0)` with `get(family_id) -> bool | None`, `set(family_id, alive)`, `invalidate(family_id)`, `clear()`; `pecunia.api.deps.AuthContext` (dataclass: `user: User`, `family_id: uuid.UUID`) and `get_current_user` dependency (401 `NOT_AUTHENTICATED` for missing/bad token or unknown user; 401 `SESSION_REVOKED` for a dead family). Task 8's router and Plan 04's domain routers depend on `get_current_user`.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_current_user.py`

```python
import uuid
from typing import Annotated

import httpx
import pytest
from fastapi import Depends

from conftest import TEST_SECRET_KEY
from pecunia.security.tokens import KeyRing, create_access_token
from pecunia.services.auth import AuthService

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"


def _mint(user_id: uuid.UUID, family_id: uuid.UUID) -> str:
    return create_access_token(
        user_id=user_id, family_id=family_id, ring=KeyRing.single(TEST_SECRET_KEY)
    )


@pytest.fixture
async def me_app(app):
    from pecunia.api.deps import AuthContext, get_current_user

    @app.get("/api/v1/_whoami")
    async def _whoami(ctx: Annotated[AuthContext, Depends(get_current_user)]):
        return {"user_id": str(ctx.user.id), "family_id": str(ctx.family_id)}

    return app


@pytest.fixture
async def me_client(me_app):
    transport = httpx.ASGITransport(app=me_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_valid_token_resolves_user(db, user_factory, me_client):
    user = await user_factory()
    session, _ = await AuthService(db).create_session(user, client="web", ip=None, user_agent=UA)
    await db.commit()
    resp = await me_client.get(
        "/api/v1/_whoami", headers={"Authorization": f"Bearer {_mint(user.id, session.family_id)}"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"user_id": str(user.id), "family_id": str(session.family_id)}


async def test_missing_and_garbage_tokens_rejected(me_client):
    assert (await me_client.get("/api/v1/_whoami")).status_code == 401
    resp = await me_client.get("/api/v1/_whoami", headers={"Authorization": "Bearer junk"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "NOT_AUTHENTICATED"


async def test_unknown_session_family_rejected(db, user_factory, me_client):
    user = await user_factory()
    await db.commit()
    resp = await me_client.get(
        "/api/v1/_whoami", headers={"Authorization": f"Bearer {_mint(user.id, uuid.uuid4())}"}
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "SESSION_REVOKED"


async def test_revocation_lag_is_bounded_by_cache_and_invalidate_is_instant(
    db, user_factory, me_app, me_client
):
    user = await user_factory()
    svc = AuthService(db)
    session, _ = await svc.create_session(user, client="web", ip=None, user_agent=UA)
    await db.commit()
    token = _mint(user.id, session.family_id)
    headers = {"Authorization": f"Bearer {token}"}

    assert (await me_client.get("/api/v1/_whoami", headers=headers)).status_code == 200
    # Revoke WITHOUT invalidating: the cached 'alive' answer still serves (the ≤30s lag).
    await svc.revoke_family(session.family_id, reason="logout")
    await db.commit()
    assert (await me_client.get("/api/v1/_whoami", headers=headers)).status_code == 200
    # Invalidate (what every revocation endpoint does in-process): instant rejection.
    me_app.state.session_cache.invalidate(session.family_id)
    resp = await me_client.get("/api/v1/_whoami", headers=headers)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "SESSION_REVOKED"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_current_user.py -v`
Expected: FAIL — `ImportError` (`pecunia.security.session_cache` / `AuthContext` missing)

- [ ] **Step 3: Implement**

`api/src/pecunia/security/session_cache.py`:

```python
import time
import uuid


class SessionCache:
    """In-process session-liveness cache (spec D1). Bounds revocation lag to
    ttl_seconds without a per-request database read; same-process revocations
    call invalidate() for instant effect. Single-process by design."""

    def __init__(self, ttl_seconds: float = 30.0):
        self.ttl = ttl_seconds
        self._entries: dict[uuid.UUID, tuple[bool, float]] = {}

    def get(self, family_id: uuid.UUID) -> bool | None:
        entry = self._entries.get(family_id)
        if entry is None or time.monotonic() - entry[1] > self.ttl:
            return None
        return entry[0]

    def set(self, family_id: uuid.UUID, alive: bool) -> None:
        self._entries[family_id] = (alive, time.monotonic())

    def invalidate(self, family_id: uuid.UUID) -> None:
        self._entries.pop(family_id, None)

    def clear(self) -> None:
        self._entries.clear()
```

In `api/src/pecunia/main.py`, add to the lifespan after the secret line:

```python
    app.state.session_cache = SessionCache()
```

with the import:

```python
from pecunia.security.session_cache import SessionCache
```

In `api/src/pecunia/api/deps.py`, extend the imports:

```python
import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.db import get_db
from pecunia.models.instance import InstanceState
from pecunia.models.user import User
from pecunia.security.session_cache import SessionCache
from pecunia.security.tokens import KeyRing, TokenError, decode_access_token
from pecunia.services.auth import AuthService
```

and append:

```python
@dataclass
class AuthContext:
    user: User
    family_id: uuid.UUID


def session_cache(request: Request) -> SessionCache:
    cache = getattr(request.app.state, "session_cache", None)
    if cache is None:
        cache = SessionCache()
        request.app.state.session_cache = cache
    return cache


async def get_current_user(
    request: Request, db: Annotated[AsyncSession, Depends(get_db)]
) -> AuthContext:
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="NOT_AUTHENTICATED")
    ring = KeyRing.single(request.app.state.secret_key)
    try:
        claims = decode_access_token(header.removeprefix("Bearer "), ring)
    except TokenError as exc:
        raise HTTPException(status_code=401, detail="NOT_AUTHENTICATED") from exc
    family_id = uuid.UUID(claims["sid"])
    cache = session_cache(request)
    alive = cache.get(family_id)
    if alive is None:
        alive = await AuthService(db).is_family_active(family_id)
        cache.set(family_id, alive)
    if not alive:
        raise HTTPException(status_code=401, detail="SESSION_REVOKED")
    user = await db.get(User, uuid.UUID(claims["sub"]))
    if user is None:
        raise HTTPException(status_code=401, detail="NOT_AUTHENTICATED")
    return AuthContext(user=user, family_id=family_id)
```

- [ ] **Step 4: Run tests to verify green, then full suite**

Run: `cd api && uv run pytest tests/test_current_user.py -v` — Expected: 4 passed.
Then: `cd api && uv run pytest -v` — Expected: 51 passed.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "feat: session-liveness cache and bearer auth dependency"
```

---

### Task 8: `/api/v1/auth/*` endpoints

**Files:**
- Create: `api/src/pecunia/api/auth.py`
- Modify: `api/src/pecunia/main.py` (include router), `api/pyproject.toml` (add `email-validator`), `api/tests/conftest.py` (add `initialized_instance` fixture)
- Test: `api/tests/test_auth_endpoints.py`

**Interfaces:**
- Consumes: `AuthService` (Tasks 5–6), tokens (Task 4), `get_current_user`/`session_cache` (Task 7), `require_initialized` (Plan 01).
- Produces (Task 9 imports these from `pecunia.api.auth`): `REFRESH_COOKIE = "pecunia_refresh"`, `COOKIE_PATH = "/api/v1/auth"`, `check_origin(request)`, `client_ip(request) -> str | None`, `set_refresh_cookie(response, request, token)`, `clear_refresh_cookie(response, request)`, `build_token_response(request, user, family_id, refresh_token) -> TokenResponse`, schemas `UserOut`/`TokenResponse`. Endpoints: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` (204), `POST /auth/logout-all` (204), `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/{family_id}` (204/404 `SESSION_NOT_FOUND`). The whole router depends on `require_initialized`.
- Produces fixture: `initialized_instance` (conftest) — seeds owner user + "Personal" workspace + membership, marks instance initialized, commits; returns `{"user", "email", "password"}`.

- [ ] **Step 1: Add dependency** — in `api/pyproject.toml` main `dependencies`, append:

```toml
    "email-validator>=2.2",
```

Run: `cd api && uv sync`

- [ ] **Step 2: Add the `initialized_instance` fixture** — in `api/tests/conftest.py`:

```python
@pytest.fixture
async def initialized_instance(db, user_factory):
    from pecunia.models import Workspace, WorkspaceMembership

    user = await user_factory()
    ws = Workspace(id=uuid.uuid4(), name="Personal")
    db.add(ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=ws.id, user_id=user.id, role="owner"))
    await db.execute(
        sa.text(
            "UPDATE instance_state SET initialized_at = now(), owner_user_id = :uid WHERE id = 1"
        ).bindparams(uid=user.id)
    )
    await db.commit()
    return {"user": user, "email": "owner@example.com", "password": "correct horse battery staple"}
```

- [ ] **Step 3: Write the failing tests** — `api/tests/test_auth_endpoints.py`

```python
import uuid

import pytest

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"}


async def test_login_requires_initialized_instance(client):
    resp = await client.post("/api/v1/auth/login", json=LOGIN)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "SETUP_REQUIRED"


async def test_web_login_sets_cookie_and_omits_body_refresh(client, initialized_instance):
    resp = await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    assert resp.status_code == 200
    body = resp.json()
    assert body["refresh_token"] is None
    assert body["expires_in"] == 900
    assert body["user"]["email"] == "owner@example.com"
    cookie_header = resp.headers["set-cookie"]
    assert "pecunia_refresh=" in cookie_header
    assert "HttpOnly" in cookie_header
    assert "Path=/api/v1/auth" in cookie_header
    assert "SameSite=strict" in cookie_header.lower() or "samesite=strict" in cookie_header.lower()


async def test_native_login_returns_body_refresh_no_cookie(client, initialized_instance):
    resp = await client.post("/api/v1/auth/login", json=LOGIN | {"client": "native"}, headers=UA)
    assert resp.status_code == 200
    assert resp.json()["refresh_token"]
    assert "set-cookie" not in resp.headers


async def test_login_failures_uniform_and_throttled(client, initialized_instance):
    bad = LOGIN | {"password": "wrong password"}
    for _ in range(5):
        resp = await client.post("/api/v1/auth/login", json=bad)
        assert resp.status_code == 401
        assert resp.json()["detail"] == "INVALID_CREDENTIALS"
    resp = await client.post("/api/v1/auth/login", json=LOGIN)
    assert resp.status_code == 429
    assert resp.json()["detail"] == "TOO_MANY_ATTEMPTS"


async def test_cross_site_origin_rejected(client, initialized_instance):
    resp = await client.post(
        "/api/v1/auth/login", json=LOGIN, headers={"Origin": "https://evil.example"}
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "ORIGIN_MISMATCH"


async def test_same_origin_allowed(client, initialized_instance):
    resp = await client.post("/api/v1/auth/login", json=LOGIN, headers={"Origin": "http://test"})
    assert resp.status_code == 200


async def test_refresh_rotates_cookie(client, initialized_instance):
    await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    first_cookie = client.cookies["pecunia_refresh"]
    resp = await client.post("/api/v1/auth/refresh")
    assert resp.status_code == 200
    assert resp.json()["access_token"]
    assert client.cookies["pecunia_refresh"] != first_cookie


async def test_refresh_replay_of_rotated_cookie_rejected(client, initialized_instance):
    await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    old_cookie = client.cookies["pecunia_refresh"]
    await client.post("/api/v1/auth/refresh")
    client.cookies.set("pecunia_refresh", old_cookie, domain="test", path="/api/v1/auth")
    resp = await client.post("/api/v1/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "INVALID_REFRESH_TOKEN"


async def test_refresh_without_any_token_rejected(client, initialized_instance):
    resp = await client.post("/api/v1/auth/refresh")
    assert resp.status_code == 401


async def test_me_returns_user_and_preferences(client, initialized_instance):
    login = await client.post("/api/v1/auth/login", json=LOGIN)
    token = login.json()["access_token"]
    resp = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["user"]["email"] == "owner@example.com"


async def test_logout_revokes_instantly(client, initialized_instance):
    login = await client.post("/api/v1/auth/login", json=LOGIN)
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (await client.post("/api/v1/auth/logout", headers=auth)).status_code == 204
    resp = await client.get("/api/v1/auth/me", headers=auth)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "SESSION_REVOKED"


async def test_sessions_list_and_targeted_revoke(client, initialized_instance):
    first = await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    second = await client.post("/api/v1/auth/login", json=LOGIN | {"client": "native"})
    auth = {"Authorization": f"Bearer {first.json()['access_token']}"}

    resp = await client.get("/api/v1/auth/sessions", headers=auth)
    assert resp.status_code == 200
    sessions = resp.json()
    assert len(sessions) == 2
    current = [s for s in sessions if s["current"]]
    other = [s for s in sessions if not s["current"]]
    assert len(current) == 1 and len(other) == 1
    assert current[0]["device_label"] == "Firefox · Linux"

    missing = await client.delete(f"/api/v1/auth/sessions/{uuid.uuid4()}", headers=auth)
    assert missing.status_code == 404

    revoked = await client.delete(f"/api/v1/auth/sessions/{other[0]['id']}", headers=auth)
    assert revoked.status_code == 204
    resp = await client.get("/api/v1/auth/sessions", headers=auth)
    assert len(resp.json()) == 1


async def test_logout_all_kills_every_session(client, initialized_instance):
    first = await client.post("/api/v1/auth/login", json=LOGIN)
    second = await client.post("/api/v1/auth/login", json=LOGIN)
    auth1 = {"Authorization": f"Bearer {first.json()['access_token']}"}
    auth2 = {"Authorization": f"Bearer {second.json()['access_token']}"}
    assert (await client.post("/api/v1/auth/logout-all", headers=auth1)).status_code == 204
    assert (await client.get("/api/v1/auth/me", headers=auth1)).status_code == 401
    assert (await client.get("/api/v1/auth/me", headers=auth2)).status_code == 401
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_auth_endpoints.py -v`
Expected: FAIL — 404s (router not mounted)

- [ ] **Step 5: Implement** — `api/src/pecunia/api/auth.py`:

```python
import uuid
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import AuthContext, get_current_user, require_initialized, session_cache
from pecunia.db import get_db
from pecunia.models.instance import InstanceState
from pecunia.security.tokens import ACCESS_TTL, KeyRing, create_access_token
from pecunia.services.auth import (
    REFRESH_ABSOLUTE,
    AuthService,
    InvalidCredentialsError,
    InvalidRefreshTokenError,
    ThrottledError,
)

REFRESH_COOKIE = "pecunia_refresh"
COOKIE_PATH = "/api/v1/auth"

router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(require_initialized)])


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    display_name: str | None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_token: str | None = None
    user: UserOut


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    client: Literal["web", "native"] = "web"


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class SessionOut(BaseModel):
    id: uuid.UUID  # family_id — the stable session identity
    client: str
    device_label: str | None
    created_at: datetime
    last_active: datetime
    current: bool


def check_origin(request: Request) -> None:
    """Reject cross-site browser requests to credential endpoints. Requests
    without Origin/Referer (curl, native clients) pass — browsers always send
    Origin on cross-site POSTs, so absence means non-browser or same-context."""
    origin = request.headers.get("origin") or request.headers.get("referer")
    if origin is None:
        return
    if urlparse(origin).netloc != request.headers.get("host", ""):
        raise HTTPException(status_code=403, detail="ORIGIN_MISMATCH")


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _is_secure(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


def set_refresh_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        httponly=True,
        samesite="strict",
        secure=_is_secure(request),
        path=COOKIE_PATH,
        max_age=int(REFRESH_ABSOLUTE.total_seconds()),
    )


def clear_refresh_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH)


def build_token_response(request, user, family_id: uuid.UUID, refresh_token: str | None) -> TokenResponse:
    access = create_access_token(
        user_id=user.id, family_id=family_id, ring=KeyRing.single(request.app.state.secret_key)
    )
    return TokenResponse(
        access_token=access,
        expires_in=int(ACCESS_TTL.total_seconds()),
        refresh_token=refresh_token,
        user=UserOut(id=user.id, email=user.email, name=user.name, display_name=user.display_name),
    )


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    check_origin(request)
    svc = AuthService(db)
    try:
        user, session, refresh_token = await svc.login(
            email=body.email,
            password=body.password,
            client=body.client,
            ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except ThrottledError:
        raise HTTPException(status_code=429, detail="TOO_MANY_ATTEMPTS") from None
    except InvalidCredentialsError:
        await db.commit()  # the failed attempt must survive the 401
        raise HTTPException(status_code=401, detail="INVALID_CREDENTIALS") from None
    await db.commit()
    if body.client == "web":
        set_refresh_cookie(response, request, refresh_token)
        return build_token_response(request, user, session.family_id, None)
    return build_token_response(request, user, session.family_id, refresh_token)


@router.post("/refresh")
async def refresh(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    body: RefreshRequest | None = None,
) -> TokenResponse:
    check_origin(request)
    token = request.cookies.get(REFRESH_COOKIE) or (body.refresh_token if body else None)
    if not token:
        raise HTTPException(status_code=401, detail="INVALID_REFRESH_TOKEN")
    try:
        user, session, new_token = await AuthService(db).refresh(
            token, ip=client_ip(request), user_agent=request.headers.get("user-agent")
        )
    except InvalidRefreshTokenError:
        await db.commit()  # persist reuse-detection family revocation, if any
        clear_refresh_cookie(response, request)
        raise HTTPException(status_code=401, detail="INVALID_REFRESH_TOKEN") from None
    await db.commit()
    if session.client == "web":
        set_refresh_cookie(response, request, new_token)
        return build_token_response(request, user, session.family_id, None)
    return build_token_response(request, user, session.family_id, new_token)


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user)],
) -> None:
    await AuthService(db).revoke_family(ctx.family_id, reason="logout")
    await db.commit()
    session_cache(request).invalidate(ctx.family_id)
    clear_refresh_cookie(response, request)


@router.post("/logout-all", status_code=204)
async def logout_all(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user)],
) -> None:
    await AuthService(db).logout_all(ctx.user.id)
    await db.commit()
    session_cache(request).clear()
    clear_refresh_cookie(response, request)


@router.get("/me")
async def me(
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user)],
) -> dict:
    state = await db.get(InstanceState, 1)
    return {
        "user": UserOut(
            id=ctx.user.id, email=ctx.user.email, name=ctx.user.name,
            display_name=ctx.user.display_name,
        ).model_dump(mode="json"),
        "preferences": state.settings if state else None,
    }


@router.get("/sessions")
async def sessions(
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user)],
) -> list[SessionOut]:
    heads = await AuthService(db).list_sessions(ctx.user.id)
    return [
        SessionOut(
            id=h.family_id,
            client=h.client,
            device_label=h.device_label,
            created_at=h.created_at,
            last_active=h.created_at,  # head row is created at the last rotation
            current=h.family_id == ctx.family_id,
        )
        for h in heads
    ]


@router.delete("/sessions/{family_id}", status_code=204)
async def revoke_session(
    family_id: uuid.UUID,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user)],
) -> None:
    found = await AuthService(db).revoke_user_family(ctx.user.id, family_id)
    if not found:
        raise HTTPException(status_code=404, detail="SESSION_NOT_FOUND")
    await db.commit()
    session_cache(request).invalidate(family_id)
```

In `api/src/pecunia/main.py`, add:

```python
from pecunia.api.auth import router as auth_router
```

```python
    app.include_router(auth_router, prefix="/api/v1")
```

- [ ] **Step 6: Run tests to verify green, then full suite**

Run: `cd api && uv run pytest tests/test_auth_endpoints.py -v` — Expected: 14 passed.
Then: `cd api && uv run pytest -v` — Expected: 65 passed.

- [ ] **Step 7: Commit**

```bash
git add api
git commit -m "feat: auth endpoints — login, refresh, logout, sessions"
```

---

### Task 9: `POST /setup/initialize` — atomic, race-safe, auto-login

**Files:**
- Create: `api/src/pecunia/services/setup.py`
- Modify: `api/src/pecunia/config.py` (add `setup_token`), `api/src/pecunia/api/setup.py`
- Test: `api/tests/test_setup_initialize.py`

**Interfaces:**
- Consumes: `require_uninitialized` (Plan 01), `hash_password` (Task 3), `AuthService.create_session` (Task 5), cookie/origin/token helpers (Task 8), `Settings` (Plan 01 Task 2).
- Produces: `pecunia.services.setup.initialize_instance(db, *, owner_name, owner_email, owner_password, preferences: dict, client, ip, user_agent) -> tuple[User, AuthSession, str]` raising `SetupAlreadyCompleteError`; `Settings.setup_token: str = ""` (env `PECUNIA_SETUP_TOKEN`); endpoint `POST /api/v1/setup/initialize` (201; validates owner + preferences; optional `X-Setup-Token`; sets refresh cookie for web; returns `TokenResponse`). This is the endpoint Plan 06's wizard calls once.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_setup_initialize.py`

```python
import asyncio
import copy

import httpx

PAYLOAD = {
    "owner": {
        "name": "Eduardo",
        "email": "owner@example.com",
        "password": "correct horse battery staple",
    },
    "preferences": {
        "base_currency": "BRL",
        "locale": "pt-BR",
        "date_format": "DD/MM/YYYY",
        "number_format": "1.234,56",
        "timezone": "America/Sao_Paulo",
        "first_day_of_week": "monday",
    },
}


async def test_initialize_creates_owner_workspace_and_logs_in(client, db):
    resp = await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    assert resp.status_code == 201
    body = resp.json()
    assert body["user"]["email"] == "owner@example.com"
    assert body["refresh_token"] is None
    assert "pecunia_refresh=" in resp.headers["set-cookie"]

    status = await client.get("/api/v1/setup/status")
    assert status.json() == {"initialized": True}

    me = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert me.status_code == 200
    assert me.json()["preferences"]["base_currency"] == "BRL"

    import sqlalchemy as sa
    ws = (await db.execute(sa.text("SELECT name FROM workspaces"))).scalar_one()
    assert ws == "Personal"
    role = (await db.execute(sa.text("SELECT role FROM workspace_memberships"))).scalar_one()
    assert role == "owner"
    owner_link = (await db.execute(
        sa.text("SELECT owner_user_id IS NOT NULL FROM instance_state WHERE id = 1")
    )).scalar_one()
    assert owner_link is True


async def test_login_works_after_initialize(client):
    await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    client.cookies.clear()
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "owner@example.com", "password": "correct horse battery staple"},
    )
    assert resp.status_code == 200


async def test_second_initialize_conflicts(client):
    assert (await client.post("/api/v1/setup/initialize", json=PAYLOAD)).status_code == 201
    resp = await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "SETUP_ALREADY_COMPLETE"


async def test_weak_password_and_bad_preferences_rejected(client):
    weak = copy.deepcopy(PAYLOAD)
    weak["owner"]["password"] = "short"
    assert (await client.post("/api/v1/setup/initialize", json=weak)).status_code == 422

    bad_currency = copy.deepcopy(PAYLOAD)
    bad_currency["preferences"]["base_currency"] = "brl!"
    assert (await client.post("/api/v1/setup/initialize", json=bad_currency)).status_code == 422

    bad_tz = copy.deepcopy(PAYLOAD)
    bad_tz["preferences"]["timezone"] = "Mars/Olympus_Mons"
    assert (await client.post("/api/v1/setup/initialize", json=bad_tz)).status_code == 422


async def test_concurrent_initialize_has_exactly_one_winner(app):
    second = copy.deepcopy(PAYLOAD)
    second["owner"]["email"] = "rival@example.com"
    transport = httpx.ASGITransport(app=app)
    async with (
        httpx.AsyncClient(transport=transport, base_url="http://test") as c1,
        httpx.AsyncClient(transport=transport, base_url="http://test") as c2,
    ):
        r1, r2 = await asyncio.gather(
            c1.post("/api/v1/setup/initialize", json=PAYLOAD),
            c2.post("/api/v1/setup/initialize", json=second),
        )
    assert sorted([r1.status_code, r2.status_code]) == [201, 409]


async def test_setup_token_gate(client, monkeypatch):
    monkeypatch.setenv("PECUNIA_SETUP_TOKEN", "sesame-open-sesame")
    resp = await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "INVALID_SETUP_TOKEN"
    resp = await client.post(
        "/api/v1/setup/initialize", json=PAYLOAD, headers={"X-Setup-Token": "sesame-open-sesame"}
    )
    assert resp.status_code == 201
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_setup_initialize.py -v`
Expected: FAIL — 405/404 (no POST route)

- [ ] **Step 3: Implement**

In `api/src/pecunia/config.py`, add to `Settings`:

```python
    setup_token: str = ""
```

`api/src/pecunia/services/setup.py`:

```python
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.models import InstanceState, User, Workspace, WorkspaceMembership
from pecunia.security.passwords import hash_password
from pecunia.services.auth import AuthService


class SetupAlreadyCompleteError(Exception):
    pass


async def initialize_instance(
    db: AsyncSession,
    *,
    owner_name: str,
    owner_email: str,
    owner_password: str,
    preferences: dict,
    client: str,
    ip: str | None,
    user_agent: str | None,
):
    """Spec D4: the one atomic write that takes the instance from uninitialized
    to initialized. Row lock serializes racing calls; exactly one wins."""
    result = await db.execute(
        select(InstanceState).where(InstanceState.id == 1).with_for_update()
    )
    state = result.scalar_one()
    if state.initialized_at is not None:
        raise SetupAlreadyCompleteError()

    user = User(
        id=uuid.uuid4(),
        email=owner_email,
        name=owner_name,
        password_hash=hash_password(owner_password),
    )
    workspace = Workspace(id=uuid.uuid4(), name="Personal")
    db.add_all([user, workspace])
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=workspace.id, user_id=user.id, role="owner"))

    state.settings = preferences
    state.owner_user_id = user.id
    state.initialized_at = datetime.now(UTC)

    session, refresh_token = await AuthService(db).create_session(
        user, client=client, ip=ip, user_agent=user_agent
    )
    return user, session, refresh_token
```

Replace `api/src/pecunia/api/setup.py` in full:

```python
import hmac
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.auth import (
    TokenResponse,
    build_token_response,
    check_origin,
    client_ip,
    set_refresh_cookie,
)
from pecunia.api.deps import get_instance_state, require_uninitialized
from pecunia.config import get_settings
from pecunia.db import get_db
from pecunia.models.instance import InstanceState
from pecunia.services.setup import SetupAlreadyCompleteError, initialize_instance

router = APIRouter(prefix="/setup", tags=["setup"])


class OwnerIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


class PreferencesIn(BaseModel):
    base_currency: str = Field(pattern=r"^[A-Z]{3}$")
    locale: str = Field(min_length=2, max_length=35)
    date_format: str = Field(min_length=1, max_length=32)
    number_format: str = Field(min_length=1, max_length=32)
    timezone: str = Field(min_length=1, max_length=64)
    first_day_of_week: Literal["monday", "sunday", "saturday"]

    @field_validator("timezone")
    @classmethod
    def _known_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("unknown timezone") from exc
        return value


class InitializeRequest(BaseModel):
    owner: OwnerIn
    preferences: PreferencesIn
    client: Literal["web", "native"] = "web"


@router.get("/status")
async def setup_status(
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> dict[str, bool]:
    return {"initialized": state.initialized_at is not None}


@router.post("/initialize", status_code=201, dependencies=[Depends(require_uninitialized)])
async def initialize(
    body: InitializeRequest,
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    check_origin(request)
    expected = get_settings().setup_token
    if expected:
        provided = request.headers.get("x-setup-token", "")
        if not hmac.compare_digest(provided, expected):
            raise HTTPException(status_code=403, detail="INVALID_SETUP_TOKEN")
    try:
        user, session, refresh_token = await initialize_instance(
            db,
            owner_name=body.owner.name,
            owner_email=body.owner.email,
            owner_password=body.owner.password,
            preferences=body.preferences.model_dump(),
            client=body.client,
            ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except SetupAlreadyCompleteError:
        raise HTTPException(status_code=409, detail="SETUP_ALREADY_COMPLETE") from None
    await db.commit()
    if body.client == "web":
        set_refresh_cookie(response, request, refresh_token)
        return build_token_response(request, user, session.family_id, None)
    return build_token_response(request, user, session.family_id, refresh_token)
```

- [ ] **Step 4: Run tests to verify green, then full suite**

Run: `cd api && uv run pytest tests/test_setup_initialize.py -v` — Expected: 6 passed.
Then: `cd api && uv run pytest -v` — Expected: 71 passed.

- [ ] **Step 5: Manual end-to-end sanity via Docker (no code changes)**

```bash
docker compose up -d --build
curl -s localhost:8480/api/v1/setup/status                 # {"initialized":false}
curl -s -X POST localhost:8480/api/v1/setup/initialize \
  -H 'Content-Type: application/json' \
  -d '{"owner":{"name":"E","email":"e@x.dev","password":"correct horse battery"},"preferences":{"base_currency":"BRL","locale":"pt-BR","date_format":"DD/MM/YYYY","number_format":"1.234,56","timezone":"America/Sao_Paulo","first_day_of_week":"monday"}}'
curl -s localhost:8480/api/v1/setup/status                 # {"initialized":true}
docker compose down -v                                     # reset the throwaway instance
```

Expected: 201 with token JSON on the initialize call; status flips to true; `down -v` so the next boot is uninitialized again.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "feat: atomic race-safe setup initialize with auto-login"
```

---

## Self-review notes

- **Spec coverage (this plan's slice):** D1 browser/native token issuance (T4, T8), key ring with kid (T4), 30s liveness cache + instant same-process revocation (T7), D2 rotation/reuse/family revocation/hashing/expiries (T5–T6), sessions UI data (T6, T8), throttling via login_attempts (T5), D4 initialize atomicity + lock + 409s + optional setup token (T9), D7 workspace/membership at initialize (T2, T9). Deliberately deferred per spec/roadmap: audit events (Plan 03), password change, `pecunia doctor` additions.
- **Type consistency check:** `family_id` is the JWT `sid` and the public session id everywhere (T4 tokens, T6 service, T7 deps, T8 schemas); `hash_refresh_token` shared between service and tests; `TEST_SECRET_KEY` defined once in conftest (T1) and imported by T7 tests; Task 9 imports only public names from `pecunia.api.auth` (T8 exports them unprefixed).
- **Known accepted trade-offs (document in reports, not fix):** logout with an *expired* access token returns 401 (client refreshes first — standard); sessions `created_at`/`last_active` both reflect the head row (family start time would need an extra query — V1 display is "since last activity"); reuse-detection leaves the cache entry to age out ≤30s (cross-request invalidation has no family handle on the failure path).
