LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_put_monthly_budget_persists_and_round_trips(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    r = await client.put(
        "/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 500000}, headers=h
    )
    assert r.status_code == 200
    assert r.json()["monthly_budget_minor"] == 500000
    me = await client.get("/api/v1/auth/me", headers=h)
    assert me.json()["preferences"]["monthly_budget_minor"] == 500000


async def test_put_monthly_budget_null_clears_it(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    await client.put(
        "/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 500000}, headers=h
    )
    r = await client.put(
        "/api/v1/settings/monthly-budget", json={"monthly_budget_minor": None}, headers=h
    )
    assert r.status_code == 200
    assert r.json()["monthly_budget_minor"] is None


async def test_put_monthly_budget_preserves_other_settings(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    r = await client.put(
        "/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 500000}, headers=h
    )
    assert r.status_code == 200
    me = await client.get("/api/v1/auth/me", headers=h)
    # base_currency seeded by initialized_instance survives the merge
    assert me.json()["preferences"]["base_currency"] == "BRL"


async def test_put_monthly_budget_negative_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    r = await client.put(
        "/api/v1/settings/monthly-budget", json={"monthly_budget_minor": -1}, headers=h
    )
    assert r.status_code == 422


async def test_put_monthly_budget_requires_auth(client, initialized_instance):
    r = await client.put("/api/v1/settings/monthly-budget", json={"monthly_budget_minor": 1})
    assert r.status_code in (401, 403)
