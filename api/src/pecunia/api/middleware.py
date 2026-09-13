import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from pecunia.config import get_settings
from pecunia.context import RequestContext, bind_context, reset_context
from pecunia.net import client_ip_from_scope


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        settings = get_settings()
        ip = client_ip_from_scope(
            request.client.host if request.client else None,
            request.headers.get("x-forwarded-for"),
            settings.trusted_proxies,
        )
        ctx = RequestContext(
            request_id=uuid.uuid4(),
            client_ip=ip,
            user_agent=request.headers.get("user-agent"),
        )
        # Stashed on request.state (not just the contextvar) so the app-level
        # handler for uncaught exceptions — which runs in ServerErrorMiddleware,
        # outside this middleware's try/finally — can still read it.
        request.state.request_id = ctx.request_id
        token = bind_context(ctx)
        try:
            response = await call_next(request)
        finally:
            reset_context(token)
        response.headers["x-request-id"] = str(ctx.request_id)
        return response
