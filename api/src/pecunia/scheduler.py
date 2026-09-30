"""Daily in-process background jobs — no extra container, no host cron.
Started as background asyncio tasks from the API's lifespan (main.py).

Crypto price sync (Track Q) is gated by `PECUNIA_ENABLE_PRICE_SYNC` (default
true, mirrors `sweeps.py`'s `_sweep_loop`). Bank sync (Track T) is its
sibling, gated by `PECUNIA_ENABLE_BANK_SYNC` AND both Pluggy credentials
being set (default true, but inert without credentials). For both: a
provider/network failure for one workspace — or anything else unexpected —
logs and never crashes the app or stops the other workspaces; the loop just
tries again in 24h."""

import asyncio
import logging
from datetime import UTC, date, datetime

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from pecunia.config import Settings
from pecunia.models import Workspace
from pecunia.services.banksync.provider import BankProvider, PluggyProvider
from pecunia.services.banksync.sync import BankSyncService
from pecunia.services.prices.provider import CoinGeckoPriceProvider, CryptoPriceProvider
from pecunia.services.prices.refresh import PriceRefreshService

logger = logging.getLogger(__name__)

SYNC_INTERVAL_SECONDS = 24 * 60 * 60
BANK_SYNC_INTERVAL_SECONDS = 24 * 60 * 60


async def run_daily_price_sync(
    sessionmaker: async_sessionmaker[AsyncSession],
    provider: CryptoPriceProvider,
    *,
    today: date,
) -> dict[str, dict[str, object]]:
    """Refreshes every workspace once. Each workspace's refresh runs in its
    own session and its own try/except, so one failure — a bug, a DB hiccup,
    anything beyond `PriceRefreshService`'s own captured `PriceProviderError`
    — logs and never stops the rest. Returns the refresh summary per
    workspace id (a workspace that raised is simply absent from the result).
    """
    async with sessionmaker() as db:
        workspace_ids = list((await db.execute(sa.select(Workspace.id))).scalars().all())

    results: dict[str, dict[str, object]] = {}
    for workspace_id in workspace_ids:
        try:
            async with sessionmaker() as db:
                result = await PriceRefreshService(db, provider).refresh(
                    workspace_id, today=today
                )
                await db.commit()
            results[str(workspace_id)] = result
        except Exception:
            logger.exception(f"Daily crypto price sync failed for workspace {workspace_id}")
    return results


async def _price_sync_loop(
    sessionmaker: async_sessionmaker[AsyncSession], provider: CryptoPriceProvider
) -> None:
    # First sync shortly after boot (an instance restarted more often than
    # daily should still eventually sync); every 24h after that — mirrors
    # sweeps.py's _sweep_loop.
    await asyncio.sleep(60)
    while True:
        try:
            result = await run_daily_price_sync(
                sessionmaker, provider, today=datetime.now(UTC).date()
            )
            logger.info(f"Daily crypto price sync completed: {result}")
        except Exception:
            logger.exception("Daily crypto price sync failed")
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)


def start_price_sync_task(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    provider: CryptoPriceProvider | None = None,
) -> asyncio.Task | None:
    """The lifespan's gate: starts the background loop only when
    `settings.enable_price_sync` is true, else returns `None` and starts
    nothing. Kept small and dependency-light (no ASGI app, no event-loop
    machinery beyond `asyncio.create_task` itself) so the gating is directly
    unit-testable."""
    if not settings.enable_price_sync:
        return None
    return asyncio.create_task(_price_sync_loop(sessionmaker, provider or CoinGeckoPriceProvider()))


async def run_daily_bank_sync(
    sessionmaker: async_sessionmaker[AsyncSession],
    provider: BankProvider,
    *,
    today: date,
) -> dict[str, dict]:
    """Syncs every workspace's bank connections once. Each workspace's sync
    runs in its own session and its own try/except, so one failure — a bug, a
    DB hiccup, anything beyond `BankSyncService.sync_workspace`'s own
    per-connection `BankProviderError` handling — logs and never stops the
    rest. Returns the sync summary per workspace id (a workspace that raised
    is simply absent from the result)."""
    async with sessionmaker() as db:
        workspace_ids = list((await db.execute(sa.select(Workspace.id))).scalars().all())

    results: dict[str, dict] = {}
    for workspace_id in workspace_ids:
        try:
            async with sessionmaker() as db:
                result = await BankSyncService(db, provider).sync_workspace(
                    workspace_id, today=today
                )
                await db.commit()
            results[str(workspace_id)] = result
        except Exception:
            logger.exception(f"Daily bank sync failed for workspace {workspace_id}")
    return results


async def _bank_sync_loop(
    sessionmaker: async_sessionmaker[AsyncSession], provider: BankProvider
) -> None:
    # First sync shortly after boot (an instance restarted more often than
    # daily should still eventually sync); every 24h after that — mirrors
    # _price_sync_loop, offset (120s vs. 60s) so the two loops' first runs
    # don't collide.
    await asyncio.sleep(120)
    while True:
        try:
            result = await run_daily_bank_sync(sessionmaker, provider, today=datetime.now(UTC).date())
            logger.info(f"Daily bank sync completed: {result}")
        except Exception:
            logger.exception("Daily bank sync failed")
        await asyncio.sleep(BANK_SYNC_INTERVAL_SECONDS)


def start_bank_sync_task(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    *,
    provider: BankProvider | None = None,
) -> asyncio.Task | None:
    """The lifespan's gate: starts the background loop only when
    `settings.enable_bank_sync` is true AND both Pluggy credentials are set
    (either missing means `banksync.get_bank_provider` would 503 anyway), else
    returns `None` and starts nothing. Kept small and dependency-light (no
    ASGI app, no event-loop machinery beyond `asyncio.create_task` itself) so
    the gating is directly unit-testable."""
    if not (settings.enable_bank_sync and settings.pluggy_client_id and settings.pluggy_client_secret):
        return None
    return asyncio.create_task(
        _bank_sync_loop(
            sessionmaker,
            provider or PluggyProvider(settings.pluggy_client_id, settings.pluggy_client_secret),
        )
    )
