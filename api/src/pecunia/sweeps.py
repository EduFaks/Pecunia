from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from pecunia.models import AuthSession, LoginAttempt

SESSION_GRACE = timedelta(days=30)
ATTEMPT_RETENTION = timedelta(days=30)


async def expire_sessions(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Delete auth_sessions whose expires_at < now - 30d. Returns count deleted."""
    cutoff = (now or datetime.now(UTC)) - SESSION_GRACE
    result = await db.execute(delete(AuthSession).where(AuthSession.expires_at < cutoff))
    await db.flush()
    return result.rowcount or 0


async def prune_login_attempts(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Delete login_attempts older than 30d. Returns count deleted."""
    cutoff = (now or datetime.now(UTC)) - ATTEMPT_RETENTION
    result = await db.execute(delete(LoginAttempt).where(LoginAttempt.occurred_at < cutoff))
    await db.flush()
    return result.rowcount or 0


async def run_sweeps(sessionmaker: async_sessionmaker[AsyncSession]) -> dict[str, int]:
    """Run all sweeps atomically in a single transaction. Returns counts per sweep."""
    async with sessionmaker() as db:
        sessions = await expire_sessions(db)
        attempts = await prune_login_attempts(db)
        await db.commit()
    return {"sessions_expired": sessions, "login_attempts_pruned": attempts}
