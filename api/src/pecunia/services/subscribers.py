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
