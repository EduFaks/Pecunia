import asyncio
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from pecunia.models import AuthSession
from pecunia.services.auth import AuthService, InvalidRefreshTokenError

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"


async def _login(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    _, session, token = await svc.login(
        email="owner@example.com", password="correct horse battery staple",
        client="web", ip="127.0.0.1", user_agent=UA,
    )
    return svc, user, session, token


async def test_refresh_rotates_within_family_and_keeps_absolute_expiry(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    _, second, new_token = await svc.refresh(token, ip="127.0.0.1", user_agent=UA)
    assert new_token != token
    assert second.family_id == first.family_id
    assert second.expires_at == first.expires_at  # absolute cap never extended
    await db.refresh(first)
    assert first.superseded_by == second.id
    assert first.last_used_at is not None


async def test_reuse_of_rotated_token_revokes_whole_family(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await svc.refresh(token, ip="127.0.0.1", user_agent=UA)
    with pytest.raises(InvalidRefreshTokenError):
        await svc.refresh(token, ip="6.6.6.6", user_agent=UA)
    rows = list((await db.execute(sa.select(AuthSession).where(AuthSession.family_id == first.family_id))).scalars())
    assert len(rows) == 2
    assert all(r.revoked_at is not None and r.revoke_reason == "reuse_detected" for r in rows)
    assert await svc.is_family_active(first.family_id) is False


async def test_unknown_token_rejected(db):
    with pytest.raises(InvalidRefreshTokenError):
        await AuthService(db).refresh("no-such-token", ip=None, user_agent=None)


async def test_absolute_expiry_rejects(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await db.execute(sa.text("UPDATE auth_sessions SET expires_at = now() - interval '1 minute'"))
    db.expire_all()
    with pytest.raises(InvalidRefreshTokenError):
        await svc.refresh(token, ip=None, user_agent=None)


async def test_idle_expiry_rejects(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await db.execute(sa.text("UPDATE auth_sessions SET idle_expires_at = now() - interval '1 minute'"))
    db.expire_all()
    with pytest.raises(InvalidRefreshTokenError):
        await svc.refresh(token, ip=None, user_agent=None)


async def test_logout_all_revokes_every_family(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    for _ in range(2):
        await svc.login(email="owner@example.com", password="correct horse battery staple",
                        client="web", ip="127.0.0.1", user_agent=UA)
    await svc.logout_all(user.id)
    assert await db.scalar(
        sa.select(sa.func.count()).select_from(AuthSession).where(AuthSession.revoked_at.is_(None))
    ) == 0


async def test_list_sessions_returns_active_family_heads_only(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    await svc.refresh(token, ip="127.0.0.1", user_agent=UA)  # rotates: 2 rows, 1 head
    await svc.login(email="owner@example.com", password="correct horse battery staple",
                    client="native", ip=None, user_agent=None)
    heads = await svc.list_sessions(user.id)
    assert len(heads) == 2
    assert all(h.superseded_by is None and h.revoked_at is None for h in heads)


async def test_revoke_user_family_checks_ownership(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    stranger_id = uuid.uuid4()
    assert await svc.revoke_user_family(stranger_id, first.family_id) is False
    assert await svc.revoke_user_family(user.id, first.family_id) is True
    assert await svc.is_family_active(first.family_id) is False


async def test_is_family_active_false_after_idle_expiry(db, user_factory):
    svc, user, first, token = await _login(db, user_factory)
    family_id = first.family_id
    await db.execute(sa.text("UPDATE auth_sessions SET idle_expires_at = now() - interval '1 minute'"))
    db.expire_all()
    assert await svc.is_family_active(family_id) is False


async def test_concurrent_refresh_with_same_token_does_not_fork_family(engine, db, user_factory):
    _svc, _user, first, token = await _login(db, user_factory)
    await db.commit()
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def attempt():
        async with maker() as s:
            try:
                await AuthService(s).refresh(token, ip=None, user_agent=None)
                await s.commit()
                return "ok"
            except InvalidRefreshTokenError:
                await s.commit()  # persists the reuse-detection revocation
                return "rejected"

    r1, r2 = await asyncio.gather(attempt(), attempt())
    assert sorted([r1, r2]) == ["ok", "rejected"]
    live_heads = (
        await db.execute(
            sa.select(sa.func.count())
            .select_from(AuthSession)
            .where(
                AuthSession.family_id == first.family_id,
                AuthSession.superseded_by.is_(None),
                AuthSession.revoked_at.is_(None),
            )
        )
    ).scalar_one()
    assert live_heads == 0  # loser tripped reuse detection → whole family revoked
