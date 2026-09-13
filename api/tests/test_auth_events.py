import sqlalchemy as sa

from pecunia.models import AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _actions(db):
    rows = (await db.execute(sa.select(AuditEvent.action).order_by(AuditEvent.id))).scalars().all()
    return list(rows)


async def test_successful_login_audited(client, initialized_instance, db):
    await client.post("/api/v1/auth/login", json=LOGIN)
    assert "auth.login.success" in await _actions(db)


async def test_successful_login_audit_row_attributes_actor(client, initialized_instance, db):
    await client.post("/api/v1/auth/login", json=LOGIN)
    row = (
        await db.execute(sa.select(AuditEvent).where(AuditEvent.action == "auth.login.success"))
    ).scalar_one()
    assert row.actor_user_id == initialized_instance["user"].id


async def test_failed_login_audited(client, initialized_instance, db):
    await client.post("/api/v1/auth/login", json=LOGIN | {"password": "wrong"})
    assert "auth.login.failed" in await _actions(db)


async def test_throttled_login_audited(client, initialized_instance, db):
    for _ in range(5):
        await client.post("/api/v1/auth/login", json=LOGIN | {"password": "wrong"})
    await client.post("/api/v1/auth/login", json=LOGIN)
    assert "auth.login.throttled" in await _actions(db)


async def test_logout_audited(client, initialized_instance, db):
    login = await client.post("/api/v1/auth/login", json=LOGIN)
    await client.post("/api/v1/auth/logout",
                      headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert "auth.logout" in await _actions(db)


async def test_logout_all_audited(client, initialized_instance, db):
    login = await client.post("/api/v1/auth/login", json=LOGIN)
    await client.post("/api/v1/auth/logout-all",
                      headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert "auth.logout_all" in await _actions(db)


async def test_revoke_session_audited(client, initialized_instance, db):
    first = await client.post("/api/v1/auth/login", json=LOGIN)
    await client.post("/api/v1/auth/login", json=LOGIN | {"client": "native"})
    auth = {"Authorization": f"Bearer {first.json()['access_token']}"}
    sessions = (await client.get("/api/v1/auth/sessions", headers=auth)).json()
    other = next(s["id"] for s in sessions if not s["current"])
    await client.delete(f"/api/v1/auth/sessions/{other}", headers=auth)
    assert "auth.session.revoked" in await _actions(db)


async def test_reuse_detection_audited(client, initialized_instance, db):
    await client.post("/api/v1/auth/login", json=LOGIN, headers={"User-Agent": "x"})
    old = client.cookies["pecunia_refresh"]
    await client.post("/api/v1/auth/refresh")
    client.cookies.clear()
    # Send the superseded token explicitly via the body rather than as a
    # cookie: httpx's cookie jar does not reliably attach a manually-`.set()`
    # cookie back onto a later request in this client (domain/path matching
    # quirk), so a cookie-jar replay never reaches AuthService.refresh() at
    # all. The endpoint accepts refresh_token in the body as a fallback,
    # which exercises the exact same reuse-detection code path.
    await client.post("/api/v1/auth/refresh", json={"refresh_token": old})
    assert "auth.session.reuse_detected" in await _actions(db)


async def test_setup_completed_and_user_created_audited(client, db):
    payload = {
        "owner": {"name": "E", "email": "e@x.dev", "password": "correct horse battery"},
        "preferences": {"base_currency": "BRL", "locale": "pt-BR", "date_format": "DD/MM/YYYY",
                        "number_format": "1.234,56", "timezone": "America/Sao_Paulo",
                        "first_day_of_week": "monday"},
    }
    await client.post("/api/v1/setup/initialize", json=payload)
    actions = await _actions(db)
    assert "setup.completed" in actions
    assert "user.created" in actions
