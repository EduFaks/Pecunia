import logging
import uuid
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.deps import (
    AuthContext,
    get_current_user,
    get_current_user_fresh,
    require_initialized,
    session_cache,
)
from pecunia.config import get_settings
from pecunia.db import get_db
from pecunia.models.instance import InstanceState
from pecunia.security.tokens import ACCESS_TTL, KeyRing, create_access_token
from pecunia.services.auth import (
    REFRESH_ABSOLUTE,
    AuthService,
    InvalidCredentialsError,
    InvalidRefreshTokenError,
    ThrottledError,
)

logger = logging.getLogger("pecunia.auth")

REFRESH_COOKIE = "pecunia_refresh"
COOKIE_PATH = "/api/v1/auth"
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]", "test"}

router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(require_initialized)])


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    display_name: str | None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_token: str | None = None
    user: UserOut


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    client: Literal["web", "native"] = "web"


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class SessionOut(BaseModel):
    id: uuid.UUID  # family_id — the stable session identity
    client: str
    device_label: str | None
    created_at: datetime
    last_active: datetime
    current: bool


def check_origin(request: Request) -> None:
    """Reject cross-site browser requests to credential endpoints. Requests
    without Origin/Referer (curl, native clients) pass — browsers always send
    Origin on cross-site POSTs, so absence means non-browser or same-context.
    When server_names is configured, also reject a request Host outside the
    allowlist (defense against DNS rebinding)."""
    settings = get_settings()
    host = request.headers.get("host", "")
    if settings.server_names and _host_without_port(host) not in settings.server_names:
        raise HTTPException(status_code=403, detail="ORIGIN_MISMATCH")
    origin = request.headers.get("origin") or request.headers.get("referer")
    if origin is None:
        return
    if urlparse(origin).netloc != host:
        raise HTTPException(status_code=403, detail="ORIGIN_MISMATCH")


def client_ip(request: Request) -> str | None:
    from pecunia.context import current_context

    ctx = current_context()
    if ctx is not None:
        return ctx.client_ip
    return request.client.host if request.client else None


def _is_secure(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


def _host_without_port(host: str) -> str:
    if host.startswith("["):
        end = host.find("]")
        return host[: end + 1] if end != -1 else host
    return host.split(":", 1)[0]


def set_refresh_cookie(response: Response, request: Request, token: str) -> None:
    if not _is_secure(request):
        host = _host_without_port(request.headers.get("host", ""))
        if host not in _LOCAL_HOSTS:
            logger.warning(
                "Serving auth cookies over plain HTTP on non-localhost host %r — "
                "the Secure flag is off; put Pecunia behind HTTPS for real use.",
                host,
            )
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        httponly=True,
        samesite="strict",
        secure=_is_secure(request),
        path=COOKIE_PATH,
        max_age=int(REFRESH_ABSOLUTE.total_seconds()),
    )


def clear_refresh_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH)


def build_token_response(request, user, family_id: uuid.UUID, refresh_token: str | None) -> TokenResponse:
    access = create_access_token(
        user_id=user.id, family_id=family_id, ring=KeyRing.single(request.app.state.secret_key)
    )
    return TokenResponse(
        access_token=access,
        expires_in=int(ACCESS_TTL.total_seconds()),
        refresh_token=refresh_token,
        user=UserOut(id=user.id, email=user.email, name=user.name, display_name=user.display_name),
    )


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    check_origin(request)
    svc = AuthService(db)
    try:
        user, session, refresh_token = await svc.login(
            email=body.email,
            password=body.password,
            client=body.client,
            ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except ThrottledError:
        await db.commit()  # the throttled-login audit event must survive the 429
        raise HTTPException(status_code=429, detail="TOO_MANY_ATTEMPTS") from None
    except InvalidCredentialsError:
        await db.commit()  # the failed attempt must survive the 401
        raise HTTPException(status_code=401, detail="INVALID_CREDENTIALS") from None
    await db.commit()
    if body.client == "web":
        set_refresh_cookie(response, request, refresh_token)
        return build_token_response(request, user, session.family_id, None)
    return build_token_response(request, user, session.family_id, refresh_token)


@router.post("/refresh")
async def refresh(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    body: RefreshRequest | None = None,
) -> TokenResponse:
    check_origin(request)
    token = request.cookies.get(REFRESH_COOKIE) or (body.refresh_token if body else None)
    if not token:
        raise HTTPException(status_code=401, detail="INVALID_REFRESH_TOKEN")
    try:
        user, session, new_token = await AuthService(db).refresh(
            token, ip=client_ip(request), user_agent=request.headers.get("user-agent")
        )
    except InvalidRefreshTokenError:
        await db.commit()  # persist reuse-detection family revocation, if any
        clear_refresh_cookie(response, request)
        raise HTTPException(status_code=401, detail="INVALID_REFRESH_TOKEN") from None
    await db.commit()
    if session.client == "web":
        set_refresh_cookie(response, request, new_token)
        return build_token_response(request, user, session.family_id, None)
    return build_token_response(request, user, session.family_id, new_token)


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user_fresh)],
) -> None:
    await AuthService(db).logout(ctx.family_id)
    await db.commit()
    session_cache(request).invalidate(ctx.family_id)
    clear_refresh_cookie(response, request)


@router.post("/logout-all", status_code=204)
async def logout_all(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user_fresh)],
) -> None:
    await AuthService(db).logout_all(ctx.user.id)
    await db.commit()
    session_cache(request).clear()
    clear_refresh_cookie(response, request)


@router.get("/me")
async def me(
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user)],
) -> dict:
    state = await db.get(InstanceState, 1)
    return {
        "user": UserOut(
            id=ctx.user.id, email=ctx.user.email, name=ctx.user.name,
            display_name=ctx.user.display_name,
        ).model_dump(mode="json"),
        "preferences": state.settings if state else None,
    }


@router.get("/sessions")
async def sessions(
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user)],
) -> list[SessionOut]:
    heads = await AuthService(db).list_sessions(ctx.user.id)
    return [
        SessionOut(
            id=h.family_id,
            client=h.client,
            device_label=h.device_label,
            created_at=h.created_at,
            last_active=h.created_at,  # head row is created at the last rotation
            current=h.family_id == ctx.family_id,
        )
        for h in heads
    ]


@router.delete("/sessions/{family_id}", status_code=204)
async def revoke_session(
    family_id: uuid.UUID,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    ctx: Annotated[AuthContext, Depends(get_current_user_fresh)],
) -> None:
    found = await AuthService(db).revoke_user_family(ctx.user.id, family_id)
    if not found:
        raise HTTPException(status_code=404, detail="SESSION_NOT_FOUND")
    await db.commit()
    session_cache(request).invalidate(family_id)
