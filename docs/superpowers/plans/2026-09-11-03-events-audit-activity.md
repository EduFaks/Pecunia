# Plan 03 — Domain Events, Audit & Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement spec D3 (audit) and the Activity/Audit split: an in-process synchronous domain-event bus, an append-only `audit_events` table (trigger-enforced) fed by a bus subscriber, a separate `activity_entries` projection, request-context middleware (request id / actor / trusted-proxy-aware client IP / user agent), read endpoints, and the Plan-02 carryovers (trusted-host allowlist, XFF client IP, revoke-reason enum, expiry sweeps).

**Architecture:** A module-level `event_bus` singleton; services `publish(db, event)` inside the request transaction; subscribers (audit recorder, activity projector) write in the **same transaction** so an operation and its audit row commit atomically. Request context flows via `contextvars` set by middleware and completed by the auth dependency. Everything obeys `docs/CONVENTIONS.md`.

**Tech Stack:** no new runtime dependencies. Uses stdlib `contextvars`, Starlette middleware, existing SQLAlchemy/FastAPI.

## Global Constraints

- **Follow `docs/CONVENTIONS.md` for every decision** (layering, naming, transaction contract, testing). Spec authority: `docs/superpowers/specs/2026-09-11-pecunia-v1-design.md` §5 (D3), "Activity vs Audit", D6.
- Audit is append-only: a Postgres trigger raises on UPDATE/DELETE of `audit_events`. Document the self-hosted limit honestly (already in spec §9).
- `before`/`after`/`metadata` come from **explicit per-resource allowlists**; a CI test fails on any allowlisted field matching `password|secret|token|hash|key`.
- Same-transaction semantics: subscribers run synchronously inside the operation's transaction (the router's single commit persists operation + audit + activity together, or nothing).
- Action ids are the closed catalog in `pecunia/audit/actions.py`, dot-separated `resource.action[.qualifier]` (spec's enumerated list + `auth.login.throttled`, `auth.session.reuse_detected`, `setup.completed`, `data.demo_seeded`, `data.demo_removed`).
- Client IP trusts `X-Forwarded-For` **only** when the immediate peer is in `PECUNIA_TRUSTED_PROXIES`; otherwise the socket peer. Never used for security decisions — display/audit only.
- No new infrastructure (D6): the bus is in-process synchronous; sweeps are asyncio lifespan tasks.
- Python 3.12, `uv run` from `api/`, TDD per task, conventional commits, **no commit trailers**, full suite green before each commit.
- Every DB test inherits `_pg_clean`. Baseline suite at branch start: 79 passed.

---

## File Structure (end state)

```
api/src/pecunia/
├── context.py                    NEW: contextvars + RequestContext + accessors
├── config.py                     MOD: trusted_proxies, server_names
├── main.py                       MOD: middleware, subscriber wiring, sweep tasks
├── net.py                        NEW: client_ip_from_scope / trusted-proxy logic
├── events/
│   ├── __init__.py               NEW: exports event_bus, DomainEvent
│   └── bus.py                    NEW: DomainEvent dataclass + EventBus
├── audit/
│   ├── __init__.py               NEW (empty)
│   ├── actions.py                NEW: Actions catalog (constants)
│   └── allowlists.py             NEW: per-resource field allowlists + project()
├── services/
│   ├── audit.py                  NEW: record_event(...) reads context, inserts row
│   ├── activity.py               NEW: activity projection helpers
│   ├── auth.py                   MOD: RevokeReason enum; publish auth events
│   ├── setup.py                  MOD: publish setup.completed / user.created
│   └── subscribers.py            NEW: register audit + activity subscribers
├── models/
│   ├── __init__.py               MOD: export AuditEvent, ActivityEntry
│   ├── audit.py                  NEW: AuditEvent
│   └── activity.py               NEW: ActivityEntry
├── api/
│   ├── middleware.py             NEW: RequestContextMiddleware
│   ├── deps.py                   MOD: set actor context; require_owner
│   ├── auth.py                   MOD: client_ip via net.py; origin uses server_names
│   ├── audit.py                  NEW: GET /audit-events
│   └── activity.py               NEW: GET /activity
├── sweeps.py                     NEW: expire_sessions / prune_login_attempts
└── alembic/versions/0003_audit_activity.py   NEW

api/tests/                        + test_context, test_net, test_event_bus,
                                  test_migration_0003, test_audit_service,
                                  test_activity, test_auth_events, test_audit_endpoints,
                                  test_activity_endpoint, test_sweeps, test_no_secret_leak
```

---

### Task 1: Request context — contextvars, trusted-proxy client IP, middleware, host allowlist

**Files:**
- Create: `api/src/pecunia/context.py`, `api/src/pecunia/net.py`, `api/src/pecunia/api/middleware.py`
- Modify: `api/src/pecunia/config.py`, `api/src/pecunia/main.py`, `api/src/pecunia/api/auth.py`, `api/src/pecunia/api/deps.py`
- Test: `api/tests/test_context.py`, `api/tests/test_net.py`

**Interfaces:**
- Produces: `pecunia.context` — `RequestContext` (dataclass: `request_id: uuid.UUID`, `actor_user_id`, `actor_session_id`, `client_ip: str|None`, `user_agent: str|None`), `current_context() -> RequestContext | None`, `bind_context(ctx)`, `set_actor(user_id, session_id)`, `reset_context(token)`; `pecunia.net.client_ip_from_scope(client_host, forwarded_for, trusted_proxies) -> str | None`; `RequestContextMiddleware`. `Settings.trusted_proxies: list[str]`, `Settings.server_names: list[str]` (parsed from comma-separated env).
- Consumes: `get_current_user`/`get_current_user_fresh` (Plan 02) call `set_actor` once the user resolves.

- [ ] **Step 1: Write failing tests** — `api/tests/test_net.py`

```python
from pecunia.net import client_ip_from_scope


def test_no_forwarded_uses_socket_peer():
    assert client_ip_from_scope("203.0.113.9", None, []) == "203.0.113.9"


def test_forwarded_honored_only_from_trusted_peer():
    # peer is the trusted proxy → trust the leftmost XFF entry
    assert client_ip_from_scope("10.0.0.2", "198.51.100.7, 10.0.0.2", ["10.0.0.2"]) == "198.51.100.7"


def test_forwarded_ignored_from_untrusted_peer():
    assert client_ip_from_scope("203.0.113.9", "1.2.3.4", []) == "203.0.113.9"


def test_empty_forwarded_falls_back_to_peer():
    assert client_ip_from_scope("10.0.0.2", "", ["10.0.0.2"]) == "10.0.0.2"


def test_none_peer_is_none():
    assert client_ip_from_scope(None, None, []) is None
```

`api/tests/test_context.py`:

```python
import uuid

from pecunia.context import (
    RequestContext,
    bind_context,
    current_context,
    reset_context,
    set_actor,
)


def test_bind_and_read_context():
    assert current_context() is None
    ctx = RequestContext(request_id=uuid.uuid4(), client_ip="127.0.0.1", user_agent="ua")
    token = bind_context(ctx)
    try:
        got = current_context()
        assert got is ctx
        uid, sid = uuid.uuid4(), uuid.uuid4()
        set_actor(uid, sid)
        assert current_context().actor_user_id == uid
        assert current_context().actor_session_id == sid
    finally:
        reset_context(token)
    assert current_context() is None


def test_set_actor_without_context_is_noop():
    reset = bind_context(None) if False else None  # ensure clean
    set_actor(uuid.uuid4(), uuid.uuid4())  # must not raise
    assert current_context() is None
```

- [ ] **Step 2: Run to verify fail** — `cd api && uv run pytest tests/test_net.py tests/test_context.py -v` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement** — `api/src/pecunia/context.py`:

```python
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, field


@dataclass
class RequestContext:
    request_id: uuid.UUID
    actor_user_id: uuid.UUID | None = None
    actor_session_id: uuid.UUID | None = None
    client_ip: str | None = None
    user_agent: str | None = None


_ctx: ContextVar[RequestContext | None] = ContextVar("pecunia_request_context", default=None)


def current_context() -> RequestContext | None:
    return _ctx.get()


def bind_context(ctx: RequestContext | None) -> Token:
    return _ctx.set(ctx)


def reset_context(token: Token) -> None:
    _ctx.reset(token)


def set_actor(user_id: uuid.UUID, session_id: uuid.UUID | None) -> None:
    ctx = _ctx.get()
    if ctx is not None:
        ctx.actor_user_id = user_id
        ctx.actor_session_id = session_id
```

`api/src/pecunia/net.py`:

```python
def client_ip_from_scope(
    client_host: str | None, forwarded_for: str | None, trusted_proxies: list[str]
) -> str | None:
    """Resolve the caller's IP for audit/display only (never a security signal).
    Honor X-Forwarded-For solely when the immediate peer is a configured trusted
    proxy; otherwise the socket peer is authoritative."""
    if client_host in trusted_proxies and forwarded_for:
        first = forwarded_for.split(",")[0].strip()
        if first:
            return first
    return client_host
```

`api/src/pecunia/api/middleware.py`:

```python
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from pecunia.config import get_settings
from pecunia.context import RequestContext, bind_context, reset_context
from pecunia.net import client_ip_from_scope


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        settings = get_settings()
        ip = client_ip_from_scope(
            request.client.host if request.client else None,
            request.headers.get("x-forwarded-for"),
            settings.trusted_proxies,
        )
        ctx = RequestContext(
            request_id=uuid.uuid4(),
            client_ip=ip,
            user_agent=request.headers.get("user-agent"),
        )
        token = bind_context(ctx)
        try:
            response = await call_next(request)
        finally:
            reset_context(token)
        response.headers["x-request-id"] = str(ctx.request_id)
        return response
```

In `config.py`, add fields + comma parsing:

```python
    trusted_proxies_raw: str = ""
    server_names_raw: str = ""

    @property
    def trusted_proxies(self) -> list[str]:
        return [p.strip() for p in self.trusted_proxies_raw.split(",") if p.strip()]

    @property
    def server_names(self) -> list[str]:
        return [s.strip() for s in self.server_names_raw.split(",") if s.strip()]
```

(env vars: `PECUNIA_TRUSTED_PROXIES_RAW`, `PECUNIA_SERVER_NAMES_RAW` — comma lists. Keep the `_raw` suffix so pydantic-settings binds a plain string, not JSON.)

In `main.py` lifespan/create_app, add the middleware (after `create_app()` builds the app, before returning): `app.add_middleware(RequestContextMiddleware)` and, when `settings.server_names` is non-empty, `app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.server_names)` (`from starlette.middleware.trustedhost import TrustedHostMiddleware`, `from pecunia.api.middleware import RequestContextMiddleware`, `get_settings()` at build time).

In `api/deps.py`, in both `_authenticate` (the shared body) after the user resolves, call `set_actor(user.id, family_id)` (`from pecunia.context import set_actor`).

In `api/auth.py`, replace `client_ip(request)` body to prefer the middleware-populated context, falling back to the socket peer:

```python
def client_ip(request: Request) -> str | None:
    from pecunia.context import current_context
    ctx = current_context()
    if ctx is not None:
        return ctx.client_ip
    return request.client.host if request.client else None
```

and update `check_origin` so that when `settings.server_names` is configured, a request Host not in the allowlist is rejected `403 ORIGIN_MISMATCH` (defense against DNS rebinding); when unset, behavior is unchanged.

- [ ] **Step 4: Green** — `cd api && uv run pytest tests/test_net.py tests/test_context.py -v`, then full suite (existing auth/setup tests still green with context now populated by middleware — note ASGITransport DOES run middleware, so `client_ip` now comes from context in tests).

- [ ] **Step 5: Commit** — `git add api && git commit -m "feat: request-context middleware with trusted-proxy client IP and host allowlist"`

---

### Task 2: In-process domain-event bus

**Files:**
- Create: `api/src/pecunia/events/__init__.py`, `api/src/pecunia/events/bus.py`
- Test: `api/tests/test_event_bus.py`

**Interfaces:**
- Produces: `pecunia.events.bus.DomainEvent` (frozen dataclass: `action: str`, `resource_type: str | None = None`, `resource_id: str | None = None`, `workspace_id: uuid.UUID | None = None`, `metadata: dict | None = None`, `before: dict | None = None`, `after: dict | None = None`, `activity_template: str | None = None`, `activity_params: dict | None = None`); `EventBus` with `subscribe(handler)`, `clear()`, `async publish(db, event)`; the module singleton `event_bus`. Handlers are `async def h(db, event) -> None`, awaited in registration order inside the caller's transaction.

- [ ] **Step 1: Failing test** — `api/tests/test_event_bus.py`

```python
import pytest

from pecunia.events.bus import DomainEvent, EventBus


@pytest.fixture
def bus():
    b = EventBus()
    yield b
    b.clear()


async def test_publish_invokes_subscribers_in_order(bus):
    seen = []
    bus.subscribe(lambda db, e: seen.append(("a", e.action)) or _async_none())
    # use real async handlers:
    calls = []

    async def h1(db, e):
        calls.append(("h1", e.action))

    async def h2(db, e):
        calls.append(("h2", e.action))

    bus.clear()
    bus.subscribe(h1)
    bus.subscribe(h2)
    await bus.publish(None, DomainEvent(action="account.created"))
    assert calls == [("h1", "account.created"), ("h2", "account.created")]


async def test_no_subscribers_is_noop(bus):
    await bus.publish(None, DomainEvent(action="x.y"))  # must not raise


def _async_none():
    async def _n():
        return None
    return _n()
```

(Implementer: replace the messy first-subscriber line — the real test is `h1`/`h2`. Delete the `bus.subscribe(lambda ...)` line and the `_async_none` helper; keep only the async-handler version. Final file must be clean.)

- [ ] **Step 2: Verify fail** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement** — `api/src/pecunia/events/bus.py`:

```python
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class DomainEvent:
    """A thing that happened in the domain. Published inside the request
    transaction; consumed synchronously by subscribers (audit, activity)."""

    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    workspace_id: uuid.UUID | None = None
    metadata: dict[str, Any] | None = None
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    activity_template: str | None = None
    activity_params: dict[str, Any] | None = None


Handler = Callable[[AsyncSession | None, DomainEvent], Awaitable[None]]


class EventBus:
    def __init__(self) -> None:
        self._handlers: list[Handler] = []

    def subscribe(self, handler: Handler) -> None:
        self._handlers.append(handler)

    def clear(self) -> None:
        self._handlers.clear()

    async def publish(self, db: AsyncSession | None, event: DomainEvent) -> None:
        for handler in self._handlers:
            await handler(db, event)


event_bus = EventBus()
```

`api/src/pecunia/events/__init__.py`:

```python
from pecunia.events.bus import DomainEvent, EventBus, event_bus

__all__ = ["DomainEvent", "EventBus", "event_bus"]
```

- [ ] **Step 4: Green + full suite. Step 5: Commit** — `feat: in-process synchronous domain-event bus`

---

### Task 3: Audit & activity models, migration, append-only trigger, allowlists

**Files:**
- Create: `api/src/pecunia/models/audit.py`, `api/src/pecunia/models/activity.py`, `api/src/pecunia/audit/__init__.py`, `api/src/pecunia/audit/actions.py`, `api/src/pecunia/audit/allowlists.py`, `api/alembic/versions/0003_audit_activity.py`
- Modify: `api/src/pecunia/models/__init__.py`
- Test: `api/tests/test_migration_0003.py`, `api/tests/test_no_secret_leak.py`

**Interfaces:**
- Produces: `AuditEvent` (`id BigInteger Identity` PK, `occurred_at`, `actor_user_id`/`actor_session_id`/`workspace_id`/`request_id` uuid nullable, `action` text, `resource_type`/`resource_id` text nullable, `ip` inet, `user_agent` text, `metadata`/`before`/`after` jsonb); `ActivityEntry` (`id BigInteger Identity` PK, `workspace_id` uuid **not null**, `occurred_at`, `template_key` text, `params` jsonb, `actor_user_id` uuid nullable, `resource_type`/`resource_id` text nullable); `pecunia.audit.actions.Actions` (constants for the full catalog); `pecunia.audit.allowlists.ALLOWLISTS: dict[str, frozenset[str]]` + `project(resource_type, obj) -> dict`.
- Note (spec deviation, documented): audit `id` is `BigInteger Identity`, not UUIDv7 — a monotonic append-only key needs no extra dependency and orders naturally. Actor/workspace are **soft** uuid references (no FK) so deleting a user never blocks or rewrites history.

- [ ] **Step 1: Failing tests** — `api/tests/test_migration_0003.py`

```python
import pytest
import sqlalchemy as sa

from pecunia.models import ActivityEntry, AuditEvent


async def test_audit_and_activity_tables_exist(db):
    db.add(AuditEvent(action="account.created", metadata_={"k": "v"}))
    db.add(ActivityEntry(workspace_id=None if False else __import__("uuid").uuid4(),
                         template_key="activity.account.created", params={}))
    await db.flush()


async def test_audit_events_reject_update(db):
    row = AuditEvent(action="account.created")
    db.add(row)
    await db.flush()
    with pytest.raises(sa.exc.DBAPIError):
        await db.execute(sa.text("UPDATE audit_events SET action = 'x' WHERE id = :i").bindparams(i=row.id))
    await db.rollback()


async def test_audit_events_reject_delete(db):
    row = AuditEvent(action="account.created")
    db.add(row)
    await db.flush()
    with pytest.raises(sa.exc.DBAPIError):
        await db.execute(sa.text("DELETE FROM audit_events WHERE id = :i").bindparams(i=row.id))
    await db.rollback()


async def test_schema_parity(engine):
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    import pecunia.models  # noqa: F401
    from pecunia.models.base import Base

    def _diff(c):
        return compare_metadata(MigrationContext.configure(c), Base.metadata)

    async with engine.connect() as conn:
        diffs = await conn.run_sync(_diff)
    meaningful = [d for d in diffs if not (d[0] == "remove_table" and d[1].name == "alembic_version")]
    assert meaningful == [], f"drift: {meaningful}"
```

`api/tests/test_no_secret_leak.py`:

```python
import re

from pecunia.audit.allowlists import ALLOWLISTS

FORBIDDEN = re.compile(r"password|secret|token|hash|key", re.IGNORECASE)


def test_no_allowlist_field_is_secret_like():
    offenders = [
        (rt, f) for rt, fields in ALLOWLISTS.items() for f in fields if FORBIDDEN.search(f)
    ]
    assert offenders == [], f"secret-like fields allow-listed: {offenders}"
```

- [ ] **Step 2: Verify fail** — ImportError.

- [ ] **Step 3: Implement models** — `api/src/pecunia/models/audit.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Identity, text
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Text, Uuid

from pecunia.models.base import Base


class AuditEvent(Base):
    """Append-only security/technical audit record (spec D3). A DB trigger blocks
    UPDATE/DELETE. Actor/workspace are soft uuid references (no FK) so history
    survives deletion of the referenced rows."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False, index=True
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    actor_session_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    request_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    resource_type: Mapped[str | None] = mapped_column(Text)
    resource_id: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(INET())
    user_agent: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB)
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
```

`api/src/pecunia/models/activity.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Identity, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import DateTime, Text, Uuid

from pecunia.models.base import Base


class ActivityEntry(Base):
    """Human-friendly product-history entry (spec Activity vs Audit). A curated
    projection of domain events; rendered client-side from template_key + params."""

    __tablename__ = "activity_entries"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False, index=True
    )
    template_key: Mapped[str] = mapped_column(Text, nullable=False)
    params: Mapped[dict] = mapped_column(JSONB, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    resource_type: Mapped[str | None] = mapped_column(Text)
    resource_id: Mapped[str | None] = mapped_column(Text)
```

`api/src/pecunia/audit/__init__.py` — empty. `api/src/pecunia/audit/actions.py`:

```python
class Actions:
    """Closed catalog of audit action identifiers (spec D3). resource.action[.qualifier]."""

    # auth
    AUTH_LOGIN_SUCCESS = "auth.login.success"
    AUTH_LOGIN_FAILED = "auth.login.failed"
    AUTH_LOGIN_THROTTLED = "auth.login.throttled"
    AUTH_LOGOUT = "auth.logout"
    AUTH_LOGOUT_ALL = "auth.logout_all"
    AUTH_SESSION_REVOKED = "auth.session.revoked"
    AUTH_SESSION_REUSE_DETECTED = "auth.session.reuse_detected"
    AUTH_PASSWORD_CHANGED = "auth.password.changed"
    # accounts
    ACCOUNT_CREATED = "account.created"
    ACCOUNT_UPDATED = "account.updated"
    ACCOUNT_ARCHIVED = "account.archived"
    ACCOUNT_DELETED = "account.deleted"
    ACCOUNT_BALANCE_RECONCILED = "account.balance_reconciled"
    # transactions
    TRANSACTION_CREATED = "transaction.created"
    TRANSACTION_UPDATED = "transaction.updated"
    TRANSACTION_DELETED = "transaction.deleted"
    TRANSACTION_RESTORED = "transaction.restored"
    TRANSACTION_IMPORTED = "transaction.imported"
    # projects
    PROJECT_CREATED = "project.created"
    PROJECT_UPDATED = "project.updated"
    PROJECT_DELETED = "project.deleted"
    PROJECT_ITEM_CREATED = "project_item.created"
    PROJECT_ITEM_UPDATED = "project_item.updated"
    # assets
    ASSET_CREATED = "asset.created"
    ASSET_UPDATED = "asset.updated"
    ASSET_DELETED = "asset.deleted"
    ASSET_VALUATION_CREATED = "asset.valuation.created"
    ASSET_VALUATION_UPDATED = "asset.valuation.updated"
    # config / data
    SETTINGS_UPDATED = "settings.updated"
    USER_CREATED = "user.created"
    USER_UPDATED = "user.updated"
    SETUP_COMPLETED = "setup.completed"
    BACKUP_CREATED = "backup.created"
    BACKUP_RESTORED = "backup.restored"
    DATA_IMPORTED = "data.imported"
    DATA_EXPORTED = "data.exported"
    DATA_DEMO_SEEDED = "data.demo_seeded"
    DATA_DEMO_REMOVED = "data.demo_removed"
```

`api/src/pecunia/audit/allowlists.py`:

```python
from typing import Any

# Per-resource field allowlists for audit before/after payloads. Only these
# fields are ever copied into an audit row — secrets are structurally
# unreachable because they are not listed. test_no_secret_leak enforces this.
ALLOWLISTS: dict[str, frozenset[str]] = {
    "user": frozenset({"id", "email", "name", "display_name", "role"}),
    "workspace": frozenset({"id", "name"}),
    "settings": frozenset(
        {"base_currency", "locale", "date_format", "number_format", "timezone", "first_day_of_week"}
    ),
}


def project(resource_type: str, obj: Any) -> dict[str, Any]:
    """Copy only the allow-listed fields of obj (an ORM instance or dict) into a
    plain dict suitable for an audit payload."""
    fields = ALLOWLISTS.get(resource_type, frozenset())
    get = obj.get if isinstance(obj, dict) else lambda k: getattr(obj, k, None)
    out: dict[str, Any] = {}
    for f in fields:
        val = get(f)
        if val is not None:
            out[f] = str(val) if not isinstance(val, (str, int, float, bool)) else val
    return out
```

(Plan 04 extends `ALLOWLISTS` for account/transaction/asset/etc. in its own change — recorded in CONVENTIONS §7.)

Migration `0003_audit_activity.py`: create both tables (matching the models, names via convention), the trigger function + triggers:

```python
"""audit and activity tables + append-only trigger

Revision ID: 0003
Revises: 0002
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import INET, JSONB

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("actor_user_id", sa.Uuid, nullable=True),
        sa.Column("actor_session_id", sa.Uuid, nullable=True),
        sa.Column("workspace_id", sa.Uuid, nullable=True),
        sa.Column("request_id", sa.Uuid, nullable=True),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("resource_type", sa.Text, nullable=True),
        sa.Column("resource_id", sa.Text, nullable=True),
        sa.Column("ip", INET(), nullable=True),
        sa.Column("user_agent", sa.Text, nullable=True),
        sa.Column("metadata", JSONB(), nullable=True),
        sa.Column("before", JSONB(), nullable=True),
        sa.Column("after", JSONB(), nullable=True),
    )
    op.create_index("ix_audit_events_occurred_at", "audit_events", ["occurred_at"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])
    op.create_index("ix_audit_events_actor_user_id_occurred_at", "audit_events", ["actor_user_id", "occurred_at"])
    op.create_index("ix_audit_events_resource", "audit_events", ["resource_type", "resource_id", "occurred_at"])
    op.create_index("ix_audit_events_workspace_id_occurred_at", "audit_events", ["workspace_id", "occurred_at"])

    op.create_table(
        "activity_entries",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("workspace_id", sa.Uuid, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("template_key", sa.Text, nullable=False),
        sa.Column("params", JSONB(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid, nullable=True),
        sa.Column("resource_type", sa.Text, nullable=True),
        sa.Column("resource_id", sa.Text, nullable=True),
    )
    op.create_index("ix_activity_entries_workspace_id_occurred_at", "activity_entries", ["workspace_id", "occurred_at"])

    op.execute(
        """
        CREATE OR REPLACE FUNCTION pecunia_block_audit_mutation() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'audit_events is append-only';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION pecunia_block_audit_mutation();
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION pecunia_block_audit_mutation();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events")
    op.execute("DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events")
    op.execute("DROP FUNCTION IF EXISTS pecunia_block_audit_mutation()")
    op.drop_table("activity_entries")
    op.drop_table("audit_events")
```

Export both models in `models/__init__.py` (alphabetized, add to `__all__`).

**Cleanup fixture:** in `conftest.py` `_pg_clean`, add `audit_events` and `activity_entries` to the truncate loop **before** the identity tables. But `audit_events` blocks DELETE via the trigger — so the cleanup must `TRUNCATE audit_events, activity_entries` (TRUNCATE is not blocked by row-level BEFORE DELETE triggers; it also resets identity). Use a single `TRUNCATE audit_events, activity_entries RESTART IDENTITY` statement in the teardown; keep `DELETE` for the FK-linked identity tables.

- [ ] **Step 4: Green** (both new test files; migration parity passes; trigger blocks update/delete). **Full suite.** **Step 5: Commit** — `feat: audit and activity tables with append-only trigger and field allowlists`

---

### Task 4: Audit service + activity projector + subscriber wiring

**Files:**
- Create: `api/src/pecunia/services/audit.py`, `api/src/pecunia/services/activity.py`, `api/src/pecunia/services/subscribers.py`
- Modify: `api/src/pecunia/main.py` (register subscribers in lifespan + a module import for tests)
- Test: `api/tests/test_audit_service.py`, `api/tests/test_activity.py`

**Interfaces:**
- Produces: `pecunia.services.audit.record_event(db, *, action, resource_type=None, resource_id=None, workspace_id=None, metadata=None, before=None, after=None) -> AuditEvent` (reads request_id/actor/ip/ua from `current_context()`); `pecunia.services.activity.project_activity(db, event) -> ActivityEntry | None`; `pecunia.services.subscribers.audit_subscriber`, `activity_subscriber`, `register_subscribers(bus)` (idempotent). `register_subscribers(event_bus)` is called in the lifespan **and** at conftest import so tests exercise the real subscribers.

- [ ] **Step 1: Failing tests** — `api/tests/test_audit_service.py`

```python
import uuid

import sqlalchemy as sa

from pecunia.audit.actions import Actions
from pecunia.context import RequestContext, bind_context, reset_context
from pecunia.models import AuditEvent
from pecunia.services.audit import record_event


async def test_record_event_captures_context(db):
    rid, uid, sid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ctx = RequestContext(request_id=rid, actor_user_id=uid, actor_session_id=sid,
                         client_ip="203.0.113.5", user_agent="ua/1")
    token = bind_context(ctx)
    try:
        await record_event(db, action=Actions.ACCOUNT_CREATED, resource_type="account",
                           resource_id="acc-1", workspace_id=None, metadata={"name": "Checking"})
    finally:
        reset_context(token)
    row = (await db.execute(sa.select(AuditEvent))).scalar_one()
    assert row.action == "account.created"
    assert row.actor_user_id == uid
    assert row.request_id == rid
    assert str(row.ip) == "203.0.113.5"
    assert row.metadata_ == {"name": "Checking"}


async def test_record_event_without_context_still_writes(db):
    await record_event(db, action=Actions.SETUP_COMPLETED)
    row = (await db.execute(sa.select(AuditEvent))).scalar_one()
    assert row.action == "setup.completed"
    assert row.actor_user_id is None
```

`api/tests/test_activity.py`:

```python
import uuid

import sqlalchemy as sa

from pecunia.events.bus import DomainEvent
from pecunia.models import ActivityEntry
from pecunia.services.activity import project_activity


async def test_event_with_activity_template_projects_entry(db):
    ws = uuid.uuid4()
    ev = DomainEvent(
        action="asset.valuation.updated", resource_type="asset", resource_id="a1",
        workspace_id=ws, activity_template="activity.asset.valuation_changed",
        activity_params={"asset": "Mercedes", "from": 480000, "to": 462000, "currency": "BRL"},
    )
    entry = await project_activity(db, ev)
    assert entry is not None
    row = (await db.execute(sa.select(ActivityEntry))).scalar_one()
    assert row.template_key == "activity.asset.valuation_changed"
    assert row.workspace_id == ws
    assert row.params["to"] == 462000


async def test_event_without_activity_template_is_skipped(db):
    ev = DomainEvent(action="auth.login.failed")
    assert await project_activity(db, ev) is None
    count = (await db.execute(sa.select(sa.func.count()).select_from(ActivityEntry))).scalar_one()
    assert count == 0
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement** — `api/src/pecunia/services/audit.py`:

```python
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.context import current_context
from pecunia.models import AuditEvent


async def record_event(
    db: AsyncSession,
    *,
    action: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
    workspace_id=None,
    metadata: dict[str, Any] | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> AuditEvent:
    ctx = current_context()
    event = AuditEvent(
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        workspace_id=workspace_id,
        metadata_=metadata,
        before=before,
        after=after,
        request_id=ctx.request_id if ctx else None,
        actor_user_id=ctx.actor_user_id if ctx else None,
        actor_session_id=ctx.actor_session_id if ctx else None,
        ip=ctx.client_ip if ctx else None,
        user_agent=ctx.user_agent if ctx else None,
    )
    db.add(event)
    await db.flush()
    return event
```

`api/src/pecunia/services/activity.py`:

```python
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.context import current_context
from pecunia.events.bus import DomainEvent
from pecunia.models import ActivityEntry


async def project_activity(db: AsyncSession, event: DomainEvent) -> ActivityEntry | None:
    """Project the curated subset of domain events (those carrying an
    activity_template) into a human-facing activity entry."""
    if not event.activity_template or event.workspace_id is None:
        return None
    ctx = current_context()
    entry = ActivityEntry(
        workspace_id=event.workspace_id,
        template_key=event.activity_template,
        params=event.activity_params or {},
        actor_user_id=ctx.actor_user_id if ctx else None,
        resource_type=event.resource_type,
        resource_id=event.resource_id,
    )
    db.add(entry)
    await db.flush()
    return entry
```

`api/src/pecunia/services/subscribers.py`:

```python
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.events.bus import DomainEvent, EventBus
from pecunia.services.activity import project_activity
from pecunia.services.audit import record_event

_REGISTERED: set[int] = set()


async def audit_subscriber(db: AsyncSession | None, event: DomainEvent) -> None:
    if db is None:
        return
    await record_event(
        db,
        action=event.action,
        resource_type=event.resource_type,
        resource_id=event.resource_id,
        workspace_id=event.workspace_id,
        metadata=event.metadata,
        before=event.before,
        after=event.after,
    )


async def activity_subscriber(db: AsyncSession | None, event: DomainEvent) -> None:
    if db is None:
        return
    await project_activity(db, event)


def register_subscribers(bus: EventBus) -> None:
    """Idempotent: wire audit + activity onto the bus exactly once per bus."""
    if id(bus) in _REGISTERED:
        return
    bus.subscribe(audit_subscriber)
    bus.subscribe(activity_subscriber)
    _REGISTERED.add(id(bus))
```

In `main.py` lifespan add `register_subscribers(event_bus)` (import both). In `conftest.py`, at import time (top-level, after imports) call `from pecunia.events import event_bus; from pecunia.services.subscribers import register_subscribers; register_subscribers(event_bus)` so publishing in tests records rows.

- [ ] **Step 4: Green + full suite. Step 5: Commit** — `feat: audit recorder, activity projector, and bus subscriber wiring`

---

### Task 5: Publish events from auth & setup; RevokeReason enum

**Files:**
- Modify: `api/src/pecunia/services/auth.py`, `api/src/pecunia/services/setup.py`, `api/src/pecunia/api/auth.py`, `api/src/pecunia/api/setup.py`
- Test: `api/tests/test_auth_events.py`

**Interfaces:**
- Produces: `pecunia.services.auth.RevokeReason` (`StrEnum`: `LOGOUT="logout"`, `LOGOUT_ALL="logout_all"`, `USER_REVOKED="user_revoked"`, `REUSE_DETECTED="reuse_detected"`, `PASSWORD_CHANGED="password_changed"`); all `revoke_reason=` call sites use it. Auth/setup services publish `DomainEvent`s via `event_bus` at: login success, login failed, login throttled, reuse detected, logout, logout-all, session revoked, setup completed (+ user.created). Events publish inside the existing transaction; the router's commit persists them.

- [ ] **Step 1: Failing tests** — `api/tests/test_auth_events.py` (representative)

```python
import sqlalchemy as sa

from pecunia.models import AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _actions(db):
    rows = (await db.execute(sa.select(AuditEvent.action).order_by(AuditEvent.id))).scalars().all()
    return list(rows)


async def test_successful_login_audited(client, initialized_instance, db):
    await client.post("/api/v1/auth/login", json=LOGIN)
    assert "auth.login.success" in await _actions(db)


async def test_failed_login_audited(client, initialized_instance, db):
    await client.post("/api/v1/auth/login", json=LOGIN | {"password": "wrong"})
    assert "auth.login.failed" in await _actions(db)


async def test_throttled_login_audited(client, initialized_instance, db):
    for _ in range(5):
        await client.post("/api/v1/auth/login", json=LOGIN | {"password": "wrong"})
    await client.post("/api/v1/auth/login", json=LOGIN)
    assert "auth.login.throttled" in await _actions(db)


async def test_logout_audited(client, initialized_instance, db):
    login = await client.post("/api/v1/auth/login", json=LOGIN)
    await client.post("/api/v1/auth/logout",
                      headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert "auth.logout" in await _actions(db)


async def test_reuse_detection_audited(client, initialized_instance, db):
    await client.post("/api/v1/auth/login", json=LOGIN, headers={"User-Agent": "x"})
    old = client.cookies["pecunia_refresh"]
    await client.post("/api/v1/auth/refresh")
    client.cookies.clear()
    client.cookies.set("pecunia_refresh", old, domain="test", path="/api/v1/auth")
    await client.post("/api/v1/auth/refresh")
    assert "auth.session.reuse_detected" in await _actions(db)


async def test_setup_completed_and_user_created_audited(client, db):
    payload = {
        "owner": {"name": "E", "email": "e@x.dev", "password": "correct horse battery"},
        "preferences": {"base_currency": "BRL", "locale": "pt-BR", "date_format": "DD/MM/YYYY",
                        "number_format": "1.234,56", "timezone": "America/Sao_Paulo",
                        "first_day_of_week": "monday"},
    }
    await client.post("/api/v1/setup/initialize", json=payload)
    actions = await _actions(db)
    assert "setup.completed" in actions
    assert "user.created" in actions
```

- [ ] **Step 2: Verify fail** (events not published yet).

- [ ] **Step 3: Implement.** Add `RevokeReason` (`from enum import StrEnum`) to `services/auth.py` and use it at every `revoke_reason=`/`reason=` site (`revoke_family`, `logout_all`, `revoke_user_family`, reuse path). Publish events:
  - In `AuthService.login`: on failure, before raising `InvalidCredentialsError`, `await event_bus.publish(self.db, DomainEvent(action=Actions.AUTH_LOGIN_FAILED, metadata={"email": email}))`; on `ThrottledError`, publish `AUTH_LOGIN_THROTTLED`; on success publish `AUTH_LOGIN_SUCCESS` with `resource_type="user"`, `resource_id=str(user.id)`.
  - Reuse path in `refresh`: publish `AUTH_SESSION_REUSE_DETECTED` (metadata `{"family_id": str(...)}`) before raising.
  - `revoke_family` (when reason is user/logout) — publish from the **router** actions (`logout`, `logout_all`, `revoke_session`) so context/actor is set: after the service call, `await event_bus.publish(db, DomainEvent(action=Actions.AUTH_LOGOUT|AUTH_LOGOUT_ALL|AUTH_SESSION_REVOKED, ...))`.
  - `setup.initialize_instance`: publish `USER_CREATED` (before=None, after=`project("user", user)`) and `SETTINGS_UPDATED` (after=`project("settings", preferences)`); the router publishes `SETUP_COMPLETED` after commit-worthy work (publish before commit so it's in-txn). Actually publish all inside `initialize_instance` before returning, since context there lacks actor (owner not yet "logged in") — that's fine, actor null is correct for setup.
  - `email-validator` etc unchanged.
  Keep publishes INSIDE the transaction (before the router's `db.commit()`), so audit rows commit atomically. For the login-failed path, the router already commits in its except-branch → the failed-login audit row commits with the login_attempt. Ensure the publish happens before that commit.

  Import `from pecunia.events import event_bus, DomainEvent` and `from pecunia.audit.actions import Actions` where needed. Use `project` from `pecunia.audit.allowlists` for before/after.

- [ ] **Step 4: Green + full suite. Step 5: Commit** — `feat: publish domain events from auth and setup; RevokeReason enum`

---

### Task 6: `require_owner` + read endpoints (audit log, activity feed)

**Files:**
- Create: `api/src/pecunia/api/audit.py`, `api/src/pecunia/api/activity.py`
- Modify: `api/src/pecunia/api/deps.py` (add `require_owner`), `api/src/pecunia/main.py` (mount)
- Test: `api/tests/test_audit_endpoints.py`, `api/tests/test_activity_endpoint.py`

**Interfaces:**
- Produces: `pecunia.api.deps.require_owner` (dependency: `AuthContext` whose user is the instance owner per `instance_state.owner_user_id`, else `403 NOT_OWNER`); `GET /api/v1/audit-events` (owner only; query filters `action`, `resource_type`, `resource_id`, `actor_user_id`, `since`, `until`; cursor pagination `?cursor=&limit=` returning `{items, next_cursor}`, newest-first, cursor = last id); `GET /api/v1/activity` (any authed user, workspace-scoped; cursor pagination). Schemas `AuditEventOut`, `ActivityEntryOut`.

- [ ] **Step 1: Failing tests** — `api/tests/test_audit_endpoints.py`

```python
LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _token(client):
    return (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]


async def test_audit_requires_auth(client, initialized_instance):
    assert (await client.get("/api/v1/audit-events")).status_code == 401


async def test_owner_can_list_audit_events(client, initialized_instance):
    token = await _token(client)
    resp = await client.get("/api/v1/audit-events", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert "items" in body and "next_cursor" in body
    assert any(i["action"] == "auth.login.success" for i in body["items"])


async def test_action_filter(client, initialized_instance):
    token = await _token(client)
    resp = await client.get("/api/v1/audit-events?action=auth.login.success",
                            headers={"Authorization": f"Bearer {token}"})
    assert all(i["action"] == "auth.login.success" for i in resp.json()["items"])


async def test_cursor_pagination(client, initialized_instance):
    token = await _token(client)
    h = {"Authorization": f"Bearer {token}"}
    first = (await client.get("/api/v1/audit-events?limit=1", headers=h)).json()
    assert len(first["items"]) == 1 and first["next_cursor"] is not None
    second = (await client.get(f"/api/v1/audit-events?limit=1&cursor={first['next_cursor']}", headers=h)).json()
    assert second["items"][0]["id"] != first["items"][0]["id"]
```

`api/tests/test_activity_endpoint.py`:

```python
LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def test_activity_requires_auth(client, initialized_instance):
    assert (await client.get("/api/v1/activity")).status_code == 401


async def test_activity_list_shape(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    resp = await client.get("/api/v1/activity", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert "items" in resp.json() and "next_cursor" in resp.json()
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.** `require_owner` in deps.py:

```python
async def require_owner(
    ctx: Annotated[AuthContext, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AuthContext:
    state = await db.get(InstanceState, 1)
    if state is None or state.owner_user_id != ctx.user.id:
        raise HTTPException(status_code=403, detail="NOT_OWNER")
    return ctx
```

`api/src/pecunia/api/audit.py` — router `prefix=""` mounted at `/api/v1`, path `/audit-events`, `dependencies=[Depends(require_initialized)]`, handler depends on `require_owner`; builds a `select(AuditEvent).order_by(AuditEvent.id.desc())` with optional `.where` per filter, `id < cursor` when cursor given, `.limit(limit+1)` to compute `next_cursor`. Cap `limit` at 200, default 50. `AuditEventOut` mirrors columns (rename `metadata_` → `metadata`).
`api/src/pecunia/api/activity.py` — path `/activity`, authed (`get_current_user`), workspace-scoped: resolve the caller's workspace via a helper (their single membership); `select(ActivityEntry).where(workspace_id == ws).order_by(id.desc())`, same cursor pagination.

Workspace resolution helper: add to `deps.py` `async def current_workspace_id(ctx, db) -> uuid.UUID` selecting the user's membership workspace (single in V1). Mount both routers in `main.py`.

- [ ] **Step 4: Green + full suite. Step 5: Commit** — `feat: audit-log and activity read endpoints with cursor pagination`

---

### Task 7: Expiry sweeps as lifespan periodic tasks

**Files:**
- Create: `api/src/pecunia/sweeps.py`
- Modify: `api/src/pecunia/main.py` (schedule the periodic task)
- Test: `api/tests/test_sweeps.py`

**Interfaces:**
- Produces: `pecunia.sweeps.expire_sessions(db, *, now=None) -> int` (deletes `auth_sessions` whose `expires_at < now - 30d`, returns count), `prune_login_attempts(db, *, now=None) -> int` (deletes `login_attempts` older than 30d), `run_sweeps(sessionmaker) -> dict`; a lifespan `asyncio.create_task` loop invoking `run_sweeps` daily (cancelled on shutdown). No new infra (D6).

- [ ] **Step 1: Failing tests** — `api/tests/test_sweeps.py`

```python
import sqlalchemy as sa

from pecunia.models import AuthSession, LoginAttempt
from pecunia.services.auth import AuthService
from pecunia.sweeps import expire_sessions, prune_login_attempts


async def test_expire_sessions_removes_only_long_dead(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    session, _ = await svc.create_session(user, client="web", ip=None, user_agent=None)
    await db.flush()
    # move it well past absolute expiry + grace
    await db.execute(sa.text("UPDATE auth_sessions SET expires_at = now() - interval '40 days'"))
    removed = await expire_sessions(db)
    assert removed == 1
    assert (await db.execute(sa.select(sa.func.count()).select_from(AuthSession))).scalar_one() == 0


async def test_expire_sessions_keeps_recent(db, user_factory):
    user = await user_factory()
    await AuthService(db).create_session(user, client="web", ip=None, user_agent=None)
    await db.flush()
    assert await expire_sessions(db) == 0


async def test_prune_login_attempts(db):
    db.add(LoginAttempt(email_tried="a@b.c", ip=None, succeeded=False))
    await db.flush()
    await db.execute(sa.text("UPDATE login_attempts SET occurred_at = now() - interval '40 days'"))
    assert await prune_login_attempts(db) == 1
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement** — `api/src/pecunia/sweeps.py`:

```python
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from pecunia.models import AuthSession, LoginAttempt

SESSION_GRACE = timedelta(days=30)
ATTEMPT_RETENTION = timedelta(days=30)


async def expire_sessions(db: AsyncSession, *, now: datetime | None = None) -> int:
    cutoff = (now or datetime.now(UTC)) - SESSION_GRACE
    result = await db.execute(delete(AuthSession).where(AuthSession.expires_at < cutoff))
    await db.flush()
    return result.rowcount or 0


async def prune_login_attempts(db: AsyncSession, *, now: datetime | None = None) -> int:
    cutoff = (now or datetime.now(UTC)) - ATTEMPT_RETENTION
    result = await db.execute(delete(LoginAttempt).where(LoginAttempt.occurred_at < cutoff))
    await db.flush()
    return result.rowcount or 0


async def run_sweeps(sessionmaker: async_sessionmaker[AsyncSession]) -> dict[str, int]:
    async with sessionmaker() as db:
        sessions = await expire_sessions(db)
        attempts = await prune_login_attempts(db)
        await db.commit()
    return {"sessions_expired": sessions, "login_attempts_pruned": attempts}
```

In `main.py` lifespan: build an `async_sessionmaker` from the engine, spawn `asyncio.create_task` running `run_sweeps` every 24h in a loop wrapped in try/except (log failures, never crash the loop); cancel the task on shutdown. Keep it minimal and guarded.

- [ ] **Step 4: Green + full suite. Step 5: Commit** — `feat: periodic session and login-attempt expiry sweeps`

---

### Task 8: Docker sanity + spec sync

**Files:**
- Modify: `.env.example` (document `PECUNIA_TRUSTED_PROXIES_RAW`, `PECUNIA_SERVER_NAMES_RAW`), `docs/superpowers/specs/2026-09-11-pecunia-v1-design.md` (record the audit-id BigInteger deviation and the deferred cache-invalidation-via-events decision), `docs/CONVENTIONS.md` §7 (fill in the events/audit specifics as implemented)
- Test: none (docs + one manual Docker check)

- [ ] **Step 1** — add to `.env.example`:

```bash
# Comma-separated IPs of trusted reverse proxies (e.g. pecunia-web). Only these
# peers may set X-Forwarded-For. Leave empty for direct/localhost access.
PECUNIA_TRUSTED_PROXIES_RAW=
# Comma-separated Host allowlist (e.g. pecunia.example.com). Empty = allow any
# (fine for localhost/LAN). Set in production to block DNS-rebinding.
PECUNIA_SERVER_NAMES_RAW=
```

- [ ] **Step 2** — spec §5: note audit `id` is `BigInteger Identity` (append-only monotonic; UUIDv7 unnecessary and dependency-free). Add a line under D3 or §9 that cache-invalidation-via-events is deferred to when password-change lands (router-level invalidation covers V1's revocation endpoints). CONVENTIONS §7: replace the "filled in when it lands" note with the actual event/audit description matching the code.

- [ ] **Step 3** — Docker check: `docker compose up -d --build`; initialize via curl; `docker compose exec pecunia-db psql -U pecunia -c "SELECT action FROM audit_events ORDER BY id;"` shows `setup.completed`/`user.created`; confirm `UPDATE audit_events SET action='x'` raises `audit_events is append-only`; `docker compose down -v`.

- [ ] **Step 4: Commit** — `docs: sync spec and conventions with implemented events/audit; document proxy env`

---

## Self-review notes

- **Spec coverage:** D3 audit (T3/T4/T6), Activity-vs-Audit split (T3/T4/T6), event bus (T2), allowlists + no-secret-leak test (T3), append-only trigger (T3), request context incl. XFF trusted-proxy (T1), read UIs' data (T6). Plan-02 carryovers: trusted-host allowlist + XFF client_ip (T1), RevokeReason enum + auth.login.throttled (T5), sweeps (T7). Deferred (documented): cache-invalidation-via-events until password-change (post-V1).
- **Type consistency:** `DomainEvent` fields identical across bus/subscribers/publishers; `Actions.*` constants are the only action source; `metadata_` (attr) ↔ `metadata` (column) mapping consistent in model, service, and `AuditEventOut`; `RevokeReason` values equal the strings Plan 02 already stored.
- **Test isolation:** `_pg_clean` truncates `audit_events`/`activity_entries` (TRUNCATE, since the trigger blocks DELETE) and registers subscribers at conftest import so publish-in-test records rows.
