LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _token(client):
    return (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]


async def test_audit_requires_auth(client, initialized_instance):
    assert (await client.get("/api/v1/audit-events")).status_code == 401


async def test_owner_can_list_audit_events(client, initialized_instance):
    token = await _token(client)
    resp = await client.get("/api/v1/audit-events", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert "items" in body and "next_cursor" in body
    assert any(i["action"] == "auth.login.success" for i in body["items"])


async def test_action_filter(client, initialized_instance):
    token = await _token(client)
    resp = await client.get("/api/v1/audit-events?action=auth.login.success",
                            headers={"Authorization": f"Bearer {token}"})
    assert all(i["action"] == "auth.login.success" for i in resp.json()["items"])


async def test_cursor_pagination(client, initialized_instance):
    await _token(client)  # two logins -> two audit rows, so a real second page exists
    token = await _token(client)
    h = {"Authorization": f"Bearer {token}"}
    first = (await client.get("/api/v1/audit-events?limit=1", headers=h)).json()
    assert len(first["items"]) == 1 and first["next_cursor"] is not None
    second = (await client.get(f"/api/v1/audit-events?limit=1&cursor={first['next_cursor']}", headers=h)).json()
    assert second["items"][0]["id"] != first["items"][0]["id"]


async def test_non_owner_forbidden(client, initialized_instance, user_factory, db):
    await user_factory(email="second@example.com")
    await db.commit()
    token = (
        await client.post(
            "/api/v1/auth/login",
            json={"email": "second@example.com", "password": "correct horse battery staple"},
        )
    ).json()["access_token"]
    resp = await client.get("/api/v1/audit-events", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "NOT_OWNER"


async def test_pagination_walk_has_no_skip_or_overlap(client, initialized_instance):
    for _ in range(5):
        await _token(client)  # five logins -> five audit rows
    h = {"Authorization": f"Bearer {await _token(client)}"}

    full = (await client.get("/api/v1/audit-events?limit=200", headers=h)).json()["items"]
    full_ids = [i["id"] for i in full]

    walked_ids: list[int] = []
    cursor = None
    while True:
        url = "/api/v1/audit-events?limit=2"
        if cursor is not None:
            url += f"&cursor={cursor}"
        page = (await client.get(url, headers=h)).json()
        walked_ids.extend(i["id"] for i in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert walked_ids == full_ids
    assert len(set(walked_ids)) == len(walked_ids)  # no overlap
