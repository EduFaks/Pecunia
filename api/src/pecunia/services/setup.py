import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.audit.actions import Actions
from pecunia.audit.allowlists import project
from pecunia.events import DomainEvent, event_bus
from pecunia.models import InstanceState, User, Workspace, WorkspaceMembership
from pecunia.security.passwords import hash_password
from pecunia.services.auth import AuthService
from pecunia.services.categories import seed_default_categories


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
    # populate_existing: the gate dependency already loaded this row into the identity map;
    # after waiting on the lock we must see the winner's committed values, not the stale snapshot.
    result = await db.execute(
        select(InstanceState)
        .where(InstanceState.id == 1)
        .with_for_update()
        .execution_options(populate_existing=True)
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
    await seed_default_categories(db, workspace.id)

    state.settings = preferences
    state.owner_user_id = user.id
    state.initialized_at = datetime.now(UTC)

    # No one is authenticated yet — the owner isn't logged in until the
    # response below hands them tokens — so actor context is correctly null
    # for these events. Published (and flushed by their subscribers) inside
    # this same transaction; the router's db.commit() persists them atomically
    # with the rest of the setup write.
    await event_bus.publish(
        db,
        DomainEvent(
            action=Actions.USER_CREATED,
            resource_type="user",
            resource_id=str(user.id),
            workspace_id=workspace.id,
            after=project("user", user),
        ),
    )
    await event_bus.publish(
        db,
        DomainEvent(
            action=Actions.SETTINGS_UPDATED,
            resource_type="settings",
            resource_id=str(state.id),
            workspace_id=workspace.id,
            after=project("settings", preferences),
        ),
    )

    session, refresh_token = await AuthService(db).create_session(
        user, client=client, ip=ip, user_agent=user_agent
    )

    await event_bus.publish(
        db,
        DomainEvent(
            action=Actions.SETUP_COMPLETED,
            resource_type="workspace",
            resource_id=str(workspace.id),
            workspace_id=workspace.id,
        ),
    )
    return user, session, refresh_token
