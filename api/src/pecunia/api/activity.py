import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import current_workspace_id, require_initialized
from pecunia.db import get_db
from pecunia.models.activity import ActivityEntry
from pecunia.pagination import DEFAULT_LIMIT, MAX_LIMIT, cursor_page

router = APIRouter(prefix="", tags=["activity"], dependencies=[Depends(require_initialized)])


class ActivityEntryOut(BaseModel):
    id: int
    occurred_at: datetime
    template_key: str
    params: dict
    actor_user_id: uuid.UUID | None
    resource_type: str | None
    resource_id: str | None

    @classmethod
    def from_model(cls, entry: ActivityEntry) -> "ActivityEntryOut":
        return cls(
            id=entry.id,
            occurred_at=entry.occurred_at,
            template_key=entry.template_key,
            params=entry.params,
            actor_user_id=entry.actor_user_id,
            resource_type=entry.resource_type,
            resource_id=entry.resource_id,
        )


class ActivityEntryPage(BaseModel):
    items: list[ActivityEntryOut]
    next_cursor: int | None


@router.get("/activity")
async def list_activity(
    db: Annotated[AsyncSession, Depends(get_db)],
    workspace_id: Annotated[uuid.UUID, Depends(current_workspace_id)],
    cursor: int | None = None,
    limit: int = DEFAULT_LIMIT,
) -> ActivityEntryPage:
    stmt = (
        select(ActivityEntry)
        .where(ActivityEntry.workspace_id == workspace_id)
        .order_by(ActivityEntry.id.desc())
    )
    items, next_cursor = await cursor_page(
        db, stmt, ActivityEntry.id, cursor=cursor, limit=limit, default=DEFAULT_LIMIT, cap=MAX_LIMIT
    )
    return ActivityEntryPage(
        items=[ActivityEntryOut.from_model(e) for e in items], next_cursor=next_cursor
    )
