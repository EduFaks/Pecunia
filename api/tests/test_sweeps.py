import sqlalchemy as sa

from pecunia.models import AuthSession, LoginAttempt
from pecunia.services.auth import AuthService
from pecunia.sweeps import expire_sessions, prune_login_attempts


async def test_expire_sessions_removes_only_long_dead(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    _session, _ = await svc.create_session(user, client="web", ip=None, user_agent=None)
    await db.flush()
    # move it well past absolute expiry + grace
    await db.execute(sa.text("UPDATE auth_sessions SET expires_at = now() - interval '40 days'"))
    removed = await expire_sessions(db)
    assert removed == 1
    assert (await db.execute(sa.select(sa.func.count()).select_from(AuthSession))).scalar_one() == 0


async def test_expire_sessions_keeps_recent(db, user_factory):
    user = await user_factory()
    await AuthService(db).create_session(user, client="web", ip=None, user_agent=None)
    await db.flush()
    assert await expire_sessions(db) == 0


async def test_prune_login_attempts(db):
    db.add(LoginAttempt(email_tried="a@b.c", ip=None, succeeded=False))
    await db.flush()
    await db.execute(sa.text("UPDATE login_attempts SET occurred_at = now() - interval '40 days'"))
    assert await prune_login_attempts(db) == 1
