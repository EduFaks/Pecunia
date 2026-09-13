import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass


@dataclass
class RequestContext:
    request_id: uuid.UUID
    actor_user_id: uuid.UUID | None = None
    actor_session_id: uuid.UUID | None = None
    client_ip: str | None = None
    user_agent: str | None = None


_ctx: ContextVar[RequestContext | None] = ContextVar("pecunia_request_context", default=None)


def current_context() -> RequestContext | None:
    return _ctx.get()


def bind_context(ctx: RequestContext | None) -> Token:
    return _ctx.set(ctx)


def reset_context(token: Token) -> None:
    _ctx.reset(token)


def set_actor(user_id: uuid.UUID, session_id: uuid.UUID | None) -> None:
    ctx = _ctx.get()
    if ctx is not None:
        ctx.actor_user_id = user_id
        ctx.actor_session_id = session_id
