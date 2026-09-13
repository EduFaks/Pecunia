import asyncio
import copy

import httpx

PAYLOAD = {
    "owner": {
        "name": "Eduardo",
        "email": "owner@example.com",
        "password": "correct horse battery staple",
    },
    "preferences": {
        "base_currency": "BRL",
        "locale": "pt-BR",
        "date_format": "DD/MM/YYYY",
        "number_format": "1.234,56",
        "timezone": "America/Sao_Paulo",
        "first_day_of_week": "monday",
    },
}


async def test_initialize_creates_owner_workspace_and_logs_in(client, db):
    resp = await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    assert resp.status_code == 201
    body = resp.json()
    assert body["user"]["email"] == "owner@example.com"
    assert body["refresh_token"] is None
    assert "pecunia_refresh=" in resp.headers["set-cookie"]

    status = await client.get("/api/v1/setup/status")
    assert status.json() == {"initialized": True}

    me = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert me.status_code == 200
    assert me.json()["preferences"]["base_currency"] == "BRL"

    import sqlalchemy as sa
    ws = (await db.execute(sa.text("SELECT name FROM workspaces"))).scalar_one()
    assert ws == "Personal"
    role = (await db.execute(sa.text("SELECT role FROM workspace_memberships"))).scalar_one()
    assert role == "owner"
    owner_link = (await db.execute(
        sa.text("SELECT owner_user_id IS NOT NULL FROM instance_state WHERE id = 1")
    )).scalar_one()
    assert owner_link is True


async def test_login_works_after_initialize(client):
    await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    client.cookies.clear()
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "owner@example.com", "password": "correct horse battery staple"},
    )
    assert resp.status_code == 200


async def test_second_initialize_conflicts(client):
    assert (await client.post("/api/v1/setup/initialize", json=PAYLOAD)).status_code == 201
    resp = await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "SETUP_ALREADY_COMPLETE"


async def test_weak_password_and_bad_preferences_rejected(client):
    weak = copy.deepcopy(PAYLOAD)
    weak["owner"]["password"] = "short"
    assert (await client.post("/api/v1/setup/initialize", json=weak)).status_code == 422

    bad_currency = copy.deepcopy(PAYLOAD)
    bad_currency["preferences"]["base_currency"] = "brl!"
    assert (await client.post("/api/v1/setup/initialize", json=bad_currency)).status_code == 422

    bad_tz = copy.deepcopy(PAYLOAD)
    bad_tz["preferences"]["timezone"] = "Mars/Olympus_Mons"
    assert (await client.post("/api/v1/setup/initialize", json=bad_tz)).status_code == 422


async def test_concurrent_initialize_has_exactly_one_winner(app):
    second = copy.deepcopy(PAYLOAD)
    second["owner"]["email"] = "rival@example.com"
    transport = httpx.ASGITransport(app=app)
    async with (
        httpx.AsyncClient(transport=transport, base_url="http://test") as c1,
        httpx.AsyncClient(transport=transport, base_url="http://test") as c2,
    ):
        r1, r2 = await asyncio.gather(
            c1.post("/api/v1/setup/initialize", json=PAYLOAD),
            c2.post("/api/v1/setup/initialize", json=second),
        )
    assert sorted([r1.status_code, r2.status_code]) == [201, 409]


async def test_setup_token_gate(client, monkeypatch):
    monkeypatch.setenv("PECUNIA_SETUP_TOKEN", "sesame-open-sesame")
    resp = await client.post("/api/v1/setup/initialize", json=PAYLOAD)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "INVALID_SETUP_TOKEN"
    resp = await client.post(
        "/api/v1/setup/initialize", json=PAYLOAD, headers={"X-Setup-Token": "sesame-open-sesame"}
    )
    assert resp.status_code == 201
