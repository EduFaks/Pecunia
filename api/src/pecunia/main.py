import asyncio
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import async_sessionmaker
from starlette.middleware.trustedhost import TrustedHostMiddleware

from pecunia.api.accounts import router as accounts_router
from pecunia.api.activity import router as activity_router
from pecunia.api.analytics import router as analytics_router
from pecunia.api.assets import router as assets_router
from pecunia.api.audit import router as audit_router
from pecunia.api.auth import router as auth_router
from pecunia.api.budgets import router as budgets_router
from pecunia.api.categories import router as categories_router
from pecunia.api.contacts import router as contacts_router
from pecunia.api.demo import router as demo_router
from pecunia.api.health import router as health_router
from pecunia.api.loans import router as loans_router
from pecunia.api.middleware import RequestContextMiddleware
from pecunia.api.portfolios import router as portfolios_router
from pecunia.api.projects import router as projects_router
from pecunia.api.scheduled_transactions import router as scheduled_transactions_router
from pecunia.api.setup import router as setup_router
from pecunia.api.subscriptions import router as subscriptions_router
from pecunia.api.transactions import router as transactions_router
from pecunia.api.transfers import router as transfers_router
from pecunia.config import get_settings
from pecunia.db import init_engine
from pecunia.events import event_bus
from pecunia.scheduler import start_price_sync_task
from pecunia.secrets import resolve_secret_key
from pecunia.security.session_cache import SessionCache
from pecunia.services.subscribers import register_subscribers
from pecunia.sweeps import run_sweeps

logger = logging.getLogger(__name__)


async def _sweep_loop(sessionmaker: async_sessionmaker) -> None:
    """First sweep 60s after boot (long enough to keep boot fast, short enough
    that an instance restarted more often than daily still sweeps); every 24h
    after that."""
    await asyncio.sleep(60)
    while True:
        try:
            result = await run_sweeps(sessionmaker)
            logger.info(f"Expiry sweeps completed: {result}")
        except Exception:
            logger.exception("Expiry sweep failed")
        await asyncio.sleep(24 * 60 * 60)  # 24 hours


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.secret_key = resolve_secret_key(settings.secret_key, settings.config_dir)
    app.state.session_cache = SessionCache()
    engine = init_engine()
    register_subscribers(event_bus)

    # Spawn periodic expiry sweeps background task
    sessionmaker = async_sessionmaker(engine)
    sweep_task = asyncio.create_task(_sweep_loop(sessionmaker))
    app.state.sweep_task = sweep_task

    # Daily crypto price sync (Track Q) — gated by PECUNIA_ENABLE_PRICE_SYNC;
    # `None` when disabled, so there is nothing to cancel on shutdown.
    price_sync_task = start_price_sync_task(settings, sessionmaker)
    app.state.price_sync_task = price_sync_task

    yield

    # Cancel the sweep task on shutdown
    sweep_task.cancel()
    try:
        await sweep_task
    except asyncio.CancelledError:
        pass

    if price_sync_task is not None:
        price_sync_task.cancel()
        try:
            await price_sync_task
        except asyncio.CancelledError:
            pass

    await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Pecunia",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.include_router(health_router, prefix="/api/v1")
    app.include_router(setup_router, prefix="/api/v1")
    app.include_router(auth_router, prefix="/api/v1")
    app.include_router(audit_router, prefix="/api/v1")
    app.include_router(activity_router, prefix="/api/v1")
    app.include_router(accounts_router, prefix="/api/v1")
    app.include_router(transactions_router, prefix="/api/v1")
    app.include_router(transfers_router, prefix="/api/v1")
    app.include_router(projects_router, prefix="/api/v1")
    app.include_router(assets_router, prefix="/api/v1")
    app.include_router(portfolios_router, prefix="/api/v1")
    app.include_router(loans_router, prefix="/api/v1")
    app.include_router(budgets_router, prefix="/api/v1")
    app.include_router(categories_router, prefix="/api/v1")
    app.include_router(contacts_router, prefix="/api/v1")
    app.include_router(scheduled_transactions_router, prefix="/api/v1")
    app.include_router(subscriptions_router, prefix="/api/v1")
    app.include_router(analytics_router, prefix="/api/v1")
    app.include_router(demo_router, prefix="/api/v1")
    app.add_middleware(RequestContextMiddleware)
    settings = get_settings()
    if settings.server_names:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.server_names)

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        """Registering for the bare `Exception` class makes Starlette install this
        as the ServerErrorMiddleware handler (outermost — runs after
        RequestContextMiddleware has already unwound), so a request id is read
        from request.state rather than the contextvar, with a generated
        fallback for the case that middleware never ran at all."""
        logger.exception("Unhandled exception", exc_info=exc)
        request_id = getattr(request.state, "request_id", None) or uuid.uuid4()
        return JSONResponse(
            status_code=500,
            content={"detail": "INTERNAL_ERROR"},
            headers={"x-request-id": str(request_id)},
        )

    return app


app = create_app()
