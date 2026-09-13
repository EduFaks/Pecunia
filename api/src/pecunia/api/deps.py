import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.context import set_actor
from pecunia.db import get_db
from pecunia.models.instance import InstanceState
from pecunia.models.user import User
from pecunia.models.workspace import WorkspaceMembership
from pecunia.security.session_cache import SessionCache
from pecunia.security.tokens import KeyRing, TokenError, decode_access_token
from pecunia.services.auth import AuthService


async def get_instance_state(db: Annotated[AsyncSession, Depends(get_db)]) -> InstanceState:
    state = await db.get(InstanceState, 1)
    if state is None:
        raise HTTPException(status_code=500, detail="INSTANCE_STATE_MISSING")
    return state


async def require_initialized(
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> InstanceState:
    if state.initialized_at is None:
        raise HTTPException(status_code=409, detail="SETUP_REQUIRED")
    return state


async def require_uninitialized(
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> InstanceState:
    if state.initialized_at is not None:
        raise HTTPException(status_code=409, detail="SETUP_ALREADY_COMPLETE")
    return state


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


async def _authenticate(
    request: Request, db: AsyncSession, *, use_cache: bool
) -> AuthContext:
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="NOT_AUTHENTICATED")
    ring = KeyRing.single(request.app.state.secret_key)
    try:
        claims = decode_access_token(header.removeprefix("Bearer "), ring)
    except TokenError as exc:
        raise HTTPException(status_code=401, detail="NOT_AUTHENTICATED") from exc
    try:
        family_id = uuid.UUID(claims["sid"])
        user_id = uuid.UUID(claims["sub"])
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="NOT_AUTHENTICATED") from exc
    cache = session_cache(request)
    alive = cache.get(family_id) if use_cache else None
    if alive is None:
        alive = await AuthService(db).is_family_active(family_id)
        if use_cache:
            cache.set(family_id, alive)
    if not alive:
        raise HTTPException(status_code=401, detail="SESSION_REVOKED")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="NOT_AUTHENTICATED")
    set_actor(user.id, family_id)
    return AuthContext(user=user, family_id=family_id)


async def get_current_user(
    request: Request, db: Annotated[AsyncSession, Depends(get_db)]
) -> AuthContext:
    return await _authenticate(request, db, use_cache=True)


async def get_current_user_fresh(
    request: Request, db: Annotated[AsyncSession, Depends(get_db)]
) -> AuthContext:
    """Cache-bypassing variant for sensitive endpoints (spec D1): revocation now,
    password change / data export when they land. Always hits the database."""
    return await _authenticate(request, db, use_cache=False)


async def require_owner(
    ctx: Annotated[AuthContext, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AuthContext:
    """Restrict an endpoint to the instance owner (spec: audit log access)."""
    state = await db.get(InstanceState, 1)
    if state is None or state.owner_user_id != ctx.user.id:
        raise HTTPException(status_code=403, detail="NOT_OWNER")
    return ctx


async def current_workspace_id(
    ctx: Annotated[AuthContext, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> uuid.UUID:
    """Resolve the caller's workspace from their membership (single in V1)."""
    workspace_id = await db.scalar(
        select(WorkspaceMembership.workspace_id).where(WorkspaceMembership.user_id == ctx.user.id)
    )
    if workspace_id is None:
        raise HTTPException(status_code=404, detail="NO_WORKSPACE")
    return workspace_id


@dataclass
class WorkspaceContext:
    ctx: AuthContext
    workspace_id: uuid.UUID


async def require_workspace(
    ctx: Annotated[AuthContext, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> WorkspaceContext:
    ws = await current_workspace_id(ctx, db)
    return WorkspaceContext(ctx=ctx, workspace_id=ws)
