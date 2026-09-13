import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
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
