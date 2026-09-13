import re
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.context import current_context
from pecunia.models import AuditEvent

# CONVENTIONS §7: metadata is structurally safe because secret-like keys are
# dropped here, at the single write path every publish site funnels through —
# not because each of the 10+ call sites is individually trusted to behave.
_SECRET_LIKE_KEY = re.compile(r"password|secret|token|hash|key", re.IGNORECASE)


def _scrub_metadata(metadata: dict[str, Any] | None) -> dict[str, Any] | None:
    if metadata is None:
        return None
    return {k: v for k, v in metadata.items() if not _SECRET_LIKE_KEY.search(k)}


async def record_event(
    db: AsyncSession,
    *,
    action: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
    workspace_id: uuid.UUID | None = None,
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
        metadata_=_scrub_metadata(metadata),
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
