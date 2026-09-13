import uuid
from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from pecunia.models import AuthSession, LoginAttempt
from pecunia.services.auth import (
    REFRESH_ABSOLUTE,
    THROTTLE_MAX_FAILURES,
    AuthService,
    InvalidCredentialsError,
    ThrottledError,
    hash_refresh_token,
)

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"


async def test_login_success_issues_session(db, user_factory):
    user = await user_factory()
    svc = AuthService(db)
    logged_user, session, refresh_token = await svc.login(
        email="owner@example.com", password="correct horse battery staple",
        client="web", ip="127.0.0.1", user_agent=UA,
    )
    assert logged_user.id == user.id
    assert session.family_id is not None
    assert session.device_label == "Firefox · Linux"
    # The raw token is never stored — only its sha256.
    stored = (await db.execute(sa.select(AuthSession.token_hash))).scalar_one()
    assert stored == hash_refresh_token(refresh_token)
    assert refresh_token not in str(stored)
    remaining = session.expires_at - datetime.now(UTC)
    assert timedelta(days=29) < remaining <= REFRESH_ABSOLUTE


async def test_login_wrong_password_uniform_error_and_recorded(db, user_factory):
    await user_factory()
    svc = AuthService(db)
    with pytest.raises(InvalidCredentialsError):
        await svc.login(email="owner@example.com", password="wrong", client="web", ip="127.0.0.1", user_agent=UA)
    attempt = (await db.execute(sa.select(LoginAttempt))).scalar_one()
    assert attempt.succeeded is False


async def test_login_unknown_email_same_error(db):
    svc = AuthService(db)
    with pytest.raises(InvalidCredentialsError):
        await svc.login(email="ghost@example.com", password="x", client="web", ip="127.0.0.1", user_agent=UA)


async def test_throttle_after_max_failures(db, user_factory):
    await user_factory()
    svc = AuthService(db)
    for _ in range(THROTTLE_MAX_FAILURES):
        with pytest.raises(InvalidCredentialsError):
            await svc.login(email="owner@example.com", password="wrong", client="web", ip="10.0.0.9", user_agent=UA)
    with pytest.raises(ThrottledError):
        await svc.login(email="owner@example.com", password="correct horse battery staple", client="web", ip="10.0.0.9", user_agent=UA)


async def test_throttle_counts_by_ip_across_emails(db):
    svc = AuthService(db)
    for i in range(THROTTLE_MAX_FAILURES):
        with pytest.raises(InvalidCredentialsError):
            await svc.login(email=f"probe{i}@example.com", password="x", client="web", ip="10.0.0.9", user_agent=UA)
    with pytest.raises(ThrottledError):
        await svc.login(email="fresh@example.com", password="x", client="web", ip="10.0.0.9", user_agent=UA)


async def test_old_failures_outside_window_do_not_throttle(db, user_factory):
    await user_factory()
    svc = AuthService(db)
    for _ in range(THROTTLE_MAX_FAILURES):
        with pytest.raises(InvalidCredentialsError):
            await svc.login(email="owner@example.com", password="wrong", client="web", ip="10.0.0.9", user_agent=UA)
    await db.execute(sa.text("UPDATE login_attempts SET occurred_at = occurred_at - interval '1 hour'"))
    user, session, token = await svc.login(
        email="owner@example.com", password="correct horse battery staple",
        client="web", ip="10.0.0.9", user_agent=UA,
    )
    assert session is not None
