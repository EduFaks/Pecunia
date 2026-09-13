import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import AuthContext, require_initialized, require_owner
from pecunia.db import get_db
from pecunia.models.audit import AuditEvent
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, cursor_page

router = APIRouter(prefix="", tags=["audit"], dependencies=[Depends(require_initialized)])


class AuditEventOut(BaseModel):
    id: int
    occurred_at: datetime
    actor_user_id: uuid.UUID | None
    actor_session_id: uuid.UUID | None
    workspace_id: uuid.UUID | None
    request_id: uuid.UUID | None
    action: str
    resource_type: str | None
    resource_id: str | None
    ip: str | None
    user_agent: str | None
    metadata: dict | None
    before: dict | None
    after: dict | None

    @classmethod
    def from_model(cls, event: AuditEvent) -> "AuditEventOut":
        return cls(
            id=event.id,
            occurred_at=event.occurred_at,
            actor_user_id=event.actor_user_id,
            actor_session_id=event.actor_session_id,
            workspace_id=event.workspace_id,
            request_id=event.request_id,
            action=event.action,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            ip=str(event.ip) if event.ip is not None else None,
            user_agent=event.user_agent,
            metadata=event.metadata_,
            before=event.before,
            after=event.after,
        )


class AuditEventPage(BaseModel):
    items: list[AuditEventOut]
    next_cursor: int | None


@router.get("/audit-events")
async def list_audit_events(
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(require_owner)],
    action: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    actor_user_id: uuid.UUID | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    cursor: int | None = None,
    limit: int = DEFAULT_LIMIT,
) -> AuditEventPage:
    stmt = select(AuditEvent)
    if action is not None:
        stmt = stmt.where(AuditEvent.action == action)
    if resource_type is not None:
        stmt = stmt.where(AuditEvent.resource_type == resource_type)
    if resource_id is not None:
        stmt = stmt.where(AuditEvent.resource_id == resource_id)
    if actor_user_id is not None:
        stmt = stmt.where(AuditEvent.actor_user_id == actor_user_id)
    if since is not None:
        stmt = stmt.where(AuditEvent.occurred_at >= since)
    if until is not None:
        stmt = stmt.where(AuditEvent.occurred_at <= until)
    stmt = stmt.order_by(AuditEvent.id.desc())

    items, next_cursor = await cursor_page(
        db, stmt, AuditEvent.id, cursor=cursor, limit=limit, default=DEFAULT_LIMIT, cap=MAX_LIMIT
    )
    return AuditEventPage(
        items=[AuditEventOut.from_model(e) for e in items], next_cursor=next_cursor
    )
