import logging
import uuid

import pytest

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"}


async def test_login_requires_initialized_instance(client):
    resp = await client.post("/api/v1/auth/login", json=LOGIN)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "SETUP_REQUIRED"


async def test_web_login_sets_cookie_and_omits_body_refresh(client, initialized_instance):
    resp = await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    assert resp.status_code == 200
    body = resp.json()
    assert body["refresh_token"] is None
    assert body["expires_in"] == 900
    assert body["user"]["email"] == "owner@example.com"
    cookie_header = resp.headers["set-cookie"]
    assert "pecunia_refresh=" in cookie_header
    assert "HttpOnly" in cookie_header
    assert "Path=/api/v1/auth" in cookie_header
    assert "SameSite=strict" in cookie_header.lower() or "samesite=strict" in cookie_header.lower()


async def test_native_login_returns_body_refresh_no_cookie(client, initialized_instance):
    resp = await client.post("/api/v1/auth/login", json=LOGIN | {"client": "native"}, headers=UA)
    assert resp.status_code == 200
    assert resp.json()["refresh_token"]
    assert "set-cookie" not in resp.headers


async def test_login_failures_uniform_and_throttled(client, initialized_instance):
    bad = LOGIN | {"password": "wrong password"}
    for _ in range(5):
        resp = await client.post("/api/v1/auth/login", json=bad)
        assert resp.status_code == 401
        assert resp.json()["detail"] == "INVALID_CREDENTIALS"
    resp = await client.post("/api/v1/auth/login", json=LOGIN)
    assert resp.status_code == 429
    assert resp.json()["detail"] == "TOO_MANY_ATTEMPTS"


async def test_cross_site_origin_rejected(client, initialized_instance):
    resp = await client.post(
        "/api/v1/auth/login", json=LOGIN, headers={"Origin": "https://evil.example"}
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "ORIGIN_MISMATCH"


async def test_same_origin_allowed(client, initialized_instance):
    resp = await client.post("/api/v1/auth/login", json=LOGIN, headers={"Origin": "http://test"})
    assert resp.status_code == 200


async def test_refresh_rotates_cookie(client, initialized_instance):
    await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    first_cookie = client.cookies["pecunia_refresh"]
    resp = await client.post("/api/v1/auth/refresh")
    assert resp.status_code == 200
    assert resp.json()["access_token"]
    assert client.cookies["pecunia_refresh"] != first_cookie


async def test_refresh_replay_of_rotated_cookie_rejected(client, initialized_instance):
    await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    old_cookie = client.cookies["pecunia_refresh"]
    await client.post("/api/v1/auth/refresh")
    client.cookies.clear()
    client.cookies.set("pecunia_refresh", old_cookie, domain="test", path="/api/v1/auth")
    resp = await client.post("/api/v1/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "INVALID_REFRESH_TOKEN"


async def test_refresh_without_any_token_rejected(client, initialized_instance):
    resp = await client.post("/api/v1/auth/refresh")
    assert resp.status_code == 401


async def test_me_returns_user_and_preferences(client, initialized_instance):
    login = await client.post("/api/v1/auth/login", json=LOGIN)
    token = login.json()["access_token"]
    resp = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["user"]["email"] == "owner@example.com"


async def test_logout_revokes_instantly(client, initialized_instance):
    login = await client.post("/api/v1/auth/login", json=LOGIN)
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (await client.post("/api/v1/auth/logout", headers=auth)).status_code == 204
    resp = await client.get("/api/v1/auth/me", headers=auth)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "SESSION_REVOKED"


async def test_sessions_list_and_targeted_revoke(client, initialized_instance):
    first = await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    second = await client.post("/api/v1/auth/login", json=LOGIN | {"client": "native"})
    auth = {"Authorization": f"Bearer {first.json()['access_token']}"}

    resp = await client.get("/api/v1/auth/sessions", headers=auth)
    assert resp.status_code == 200
    sessions = resp.json()
    assert len(sessions) == 2
    current = [s for s in sessions if s["current"]]
    other = [s for s in sessions if not s["current"]]
    assert len(current) == 1 and len(other) == 1
    assert current[0]["device_label"] == "Firefox · Linux"

    missing = await client.delete(f"/api/v1/auth/sessions/{uuid.uuid4()}", headers=auth)
    assert missing.status_code == 404

    revoked = await client.delete(f"/api/v1/auth/sessions/{other[0]['id']}", headers=auth)
    assert revoked.status_code == 204
    resp = await client.get("/api/v1/auth/sessions", headers=auth)
    assert len(resp.json()) == 1


async def test_plain_http_off_localhost_warns(client, initialized_instance, caplog):
    caplog.set_level(logging.WARNING, logger="pecunia.auth")
    resp = await client.post(
        "/api/v1/auth/login", json=LOGIN, headers=UA | {"Host": "example.com"}
    )
    assert resp.status_code == 200
    assert any("plain HTTP" in r.message for r in caplog.records)


async def test_normal_login_produces_no_plain_http_warning(client, initialized_instance, caplog):
    caplog.set_level(logging.WARNING, logger="pecunia.auth")
    resp = await client.post("/api/v1/auth/login", json=LOGIN, headers=UA)
    assert resp.status_code == 200
    assert caplog.records == []


async def test_logout_all_kills_every_session(client, initialized_instance):
    first = await client.post("/api/v1/auth/login", json=LOGIN)
    second = await client.post("/api/v1/auth/login", json=LOGIN)
    auth1 = {"Authorization": f"Bearer {first.json()['access_token']}"}
    auth2 = {"Authorization": f"Bearer {second.json()['access_token']}"}
    assert (await client.post("/api/v1/auth/logout-all", headers=auth1)).status_code == 204
    assert (await client.get("/api/v1/auth/me", headers=auth1)).status_code == 401
    assert (await client.get("/api/v1/auth/me", headers=auth2)).status_code == 401
