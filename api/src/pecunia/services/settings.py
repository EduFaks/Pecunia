"""Workspace-scoped settings writes. Currently a single key: the optional
monthly budget, stored at `instance_state.settings["monthly_budget_minor"]`
(int minor units, base currency; absent = unset). Preferences themselves stay
read-only (set once at setup, see services/setup.py) — this module only ever
merges additional keys into the same JSONB blob, never replaces it."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models import InstanceState


async def set_monthly_budget(
    db: AsyncSession, *, workspace_id: uuid.UUID, monthly_budget_minor: int | None
) -> dict:
    """Services flush, never commit (CONVENTIONS §2) — the caller owns the
    transaction boundary. The JSONB column has no change-tracking proxy, so a
    plain in-place mutation of `state.settings` would not be seen as dirty;
    reassigning to a new dict is what makes SQLAlchemy flush the update."""
    state = (await db.execute(select(InstanceState).where(InstanceState.id == 1))).scalar_one()
    merged = dict(state.settings or {})
    if monthly_budget_minor is None:
        merged.pop("monthly_budget_minor", None)
    else:
        merged["monthly_budget_minor"] = monthly_budget_minor
    state.settings = merged
    await db.flush()
    await event_bus.publish(
        db,
        DomainEvent(
            action=Actions.SETTINGS_UPDATED,
            resource_type="settings",
            resource_id=str(state.id),
            workspace_id=workspace_id,
            after=project("settings", merged),
        ),
    )
    return merged
