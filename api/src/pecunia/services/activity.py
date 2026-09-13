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
