import uuid

import sqlalchemy as sa

from pecunia.models import ActivityEntry, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {"name": "Tesla Model 3", "type": "vehicle", "currency": "BRL"}


async def _auth(client):
    return {"Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"}


async def _asset(client, h, **overrides):
    body = dict(NEW)
    body.update(overrides)
    return (await client.post("/api/v1/assets", json=body, headers=h)).json()


async def test_create_asset(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post("/api/v1/assets", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Tesla Model 3"
    assert body["type"] == "vehicle"
    assert body["currency"] == "BRL"
    assert body["acquired_on"] is None
    assert body["current_value_minor"] is None
    assert body["is_demo"] is False
    assert uuid.UUID(body["id"])


async def test_create_asset_with_acquired_on(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/assets", json=NEW | {"acquired_on": "2020-05-01"}, headers=h
    )
    assert resp.status_code == 201
    assert resp.json()["acquired_on"] == "2020-05-01"


async def test_create_asset_with_initial_value_records_first_valuation(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/assets",
        json=NEW | {"value_minor": 4000000, "as_of": "2026-01-01"},
        headers=h,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["current_value_minor"] == 4000000
    assert body["currency"] == "BRL"

    valuations = (
        await client.get(f"/api/v1/assets/{body['id']}/valuations", headers=h)
    ).json()["items"]
    assert len(valuations) == 1
    assert valuations[0]["value_minor"] == 4000000
    assert valuations[0]["as_of"] == "2026-01-01"


async def test_create_asset_value_without_as_of_returns_422(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/assets", json=NEW | {"value_minor": 4000000}, headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "VALUATION_AS_OF_REQUIRED"


async def test_create_asset_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/assets", json=NEW)
    assert resp.status_code == 401


async def test_invalid_type_and_currency_rejected(client, initialized_instance):
    h = await _auth(client)
    assert (await client.post("/api/v1/assets", json=NEW | {"type": "yacht"}, headers=h)).status_code == 422
    assert (await client.post("/api/v1/assets", json=NEW | {"currency": "brl"}, headers=h)).status_code == 422


async def test_list_and_get(client, initialized_instance):
    h = await _auth(client)
    created = await _asset(client, h)
    lst = (await client.get("/api/v1/assets", headers=h)).json()
    assert any(a["id"] == created["id"] for a in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/assets/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/assets/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ASSET_NOT_FOUND"


async def test_update_asset(client, initialized_instance):
    h = await _auth(client)
    created = await _asset(client, h)
    resp = await client.patch(
        f"/api/v1/assets/{created['id']}", json={"name": "Tesla Model Y"}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Tesla Model Y"
    assert body["type"] == "vehicle"  # untouched field preserved
    got = (await client.get(f"/api/v1/assets/{created['id']}", headers=h)).json()
    assert got["name"] == "Tesla Model Y"


async def test_update_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.patch(f"/api/v1/assets/{uuid.uuid4()}", json={"name": "X"}, headers=h)
    assert resp.status_code == 404


async def test_delete_asset_is_hard_delete(client, initialized_instance):
    h = await _auth(client)
    created = await _asset(client, h)
    resp = await client.delete(f"/api/v1/assets/{created['id']}", headers=h)
    assert resp.status_code == 204
    got = await client.get(f"/api/v1/assets/{created['id']}", headers=h)
    assert got.status_code == 404
    lst = (await client.get("/api/v1/assets", headers=h)).json()
    assert all(a["id"] != created["id"] for a in lst["items"])


async def test_delete_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.delete(f"/api/v1/assets/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404


async def test_add_valuation_returns_created_valuation(client, initialized_instance):
    h = await _auth(client)
    created = await _asset(client, h)
    resp = await client.post(
        f"/api/v1/assets/{created['id']}/valuations",
        json={"value_minor": 4000000, "as_of": "2026-01-01", "source": "manual"},
        headers=h,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["value_minor"] == 4000000
    assert body["as_of"] == "2026-01-01"
    assert body["source"] == "manual"
    assert body["asset_id"] == created["id"]
    assert body["is_demo"] is False
    assert uuid.UUID(body["id"])


async def test_add_valuation_to_missing_asset_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        f"/api/v1/assets/{uuid.uuid4()}/valuations",
        json={"value_minor": 100, "as_of": "2026-01-01"},
        headers=h,
    )
    assert resp.status_code == 404


async def test_list_valuations(client, initialized_instance):
    h = await _auth(client)
    created = await _asset(client, h)
    valuation = (
        await client.post(
            f"/api/v1/assets/{created['id']}/valuations",
            json={"value_minor": 4000000, "as_of": "2026-01-01"},
            headers=h,
        )
    ).json()
    lst = (await client.get(f"/api/v1/assets/{created['id']}/valuations", headers=h)).json()
    assert any(v["id"] == valuation["id"] for v in lst["items"])
    assert "next_cursor" in lst


async def test_list_valuations_of_missing_asset_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/assets/{uuid.uuid4()}/valuations", headers=h)
    assert resp.status_code == 404


async def test_update_valuation(client, initialized_instance):
    h = await _auth(client)
    created = await _asset(client, h)
    valuation = (
        await client.post(
            f"/api/v1/assets/{created['id']}/valuations",
            json={"value_minor": 4000000, "as_of": "2026-01-01"},
            headers=h,
        )
    ).json()
    resp = await client.patch(
        f"/api/v1/assets/{created['id']}/valuations/{valuation['id']}",
        json={"value_minor": 4200000},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["value_minor"] == 4200000
    assert body["as_of"] == "2026-01-01"  # untouched field preserved
    got = (await client.get(f"/api/v1/assets/{created['id']}", headers=h)).json()
    assert got["current_value_minor"] == 4200000


async def test_update_valuation_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    created = await _asset(client, h)
    resp = await client.patch(
        f"/api/v1/assets/{created['id']}/valuations/{uuid.uuid4()}",
        json={"value_minor": 1},
        headers=h,
    )
    assert resp.status_code == 404


async def test_current_value_is_latest_by_as_of_and_change_activity(client, initialized_instance, db):
    h = await _auth(client)
    created = await _asset(client, h)

    # First valuation: no prior value, so no "changed" activity fires.
    await client.post(
        f"/api/v1/assets/{created['id']}/valuations",
        json={"value_minor": 4000000, "as_of": "2026-01-01", "source": "manual"},
        headers=h,
    )
    got = (await client.get(f"/api/v1/assets/{created['id']}", headers=h)).json()
    assert got["current_value_minor"] == 4000000
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert templates.count("activity.asset.valuation_changed") == 0

    # Second valuation, later as_of: becomes the new current value, and a
    # prior valuation existed -> "valuation_changed" fires with from/to.
    await client.post(
        f"/api/v1/assets/{created['id']}/valuations",
        json={"value_minor": 4500000, "as_of": "2026-06-01", "source": "manual"},
        headers=h,
    )
    got = (await client.get(f"/api/v1/assets/{created['id']}", headers=h)).json()
    assert got["current_value_minor"] == 4500000

    rows = (
        await db.execute(
            sa.select(ActivityEntry.template_key, ActivityEntry.params).where(
                ActivityEntry.template_key == "activity.asset.valuation_changed"
            )
        )
    ).all()
    assert len(rows) == 1
    params = rows[0].params
    assert params["from"] == 4000000
    assert params["to"] == 4500000
    assert params["currency"] == "BRL"
    assert params["asset"] == "Tesla Model 3"


async def test_current_value_uses_latest_as_of_even_when_added_out_of_order(
    client, initialized_instance, db
):
    h = await _auth(client)
    created = await _asset(client, h)
    # Add the later-dated valuation first...
    await client.post(
        f"/api/v1/assets/{created['id']}/valuations",
        json={"value_minor": 5000000, "as_of": "2026-06-01"},
        headers=h,
    )
    # ...then a backfilled valuation with an earlier as_of. It should NOT
    # become current — and since the current value is unchanged, it must NOT
    # emit "valuation_changed" either (there's a prior valuation, but nothing
    # about the current value actually changed).
    await client.post(
        f"/api/v1/assets/{created['id']}/valuations",
        json={"value_minor": 3000000, "as_of": "2026-01-01"},
        headers=h,
    )
    got = (await client.get(f"/api/v1/assets/{created['id']}", headers=h)).json()
    assert got["current_value_minor"] == 5000000
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert templates.count("activity.asset.valuation_changed") == 0

    # Now an in-order, newer valuation DOES change the current value — this
    # one fires "valuation_changed" with from=the old current (5000000) to
    # the new current (6000000), not from the backfilled row.
    await client.post(
        f"/api/v1/assets/{created['id']}/valuations",
        json={"value_minor": 6000000, "as_of": "2026-09-01"},
        headers=h,
    )
    got = (await client.get(f"/api/v1/assets/{created['id']}", headers=h)).json()
    assert got["current_value_minor"] == 6000000
    rows = (
        await db.execute(
            sa.select(ActivityEntry.template_key, ActivityEntry.params).where(
                ActivityEntry.template_key == "activity.asset.valuation_changed"
            )
        )
    ).all()
    assert len(rows) == 1
    assert rows[0].params["from"] == 5000000
    assert rows[0].params["to"] == 6000000


async def test_cross_workspace_asset_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    created = await _asset(client, h)
    valuation = (
        await client.post(
            f"/api/v1/assets/{created['id']}/valuations",
            json={"value_minor": 1000, "as_of": "2026-01-01"},
            headers=h,
        )
    ).json()

    other_user = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    await db.commit()

    other_token = (
        await client.post(
            "/api/v1/auth/login",
            json={"email": "other@example.com", "password": "correct horse battery staple"},
        )
    ).json()["access_token"]
    other_h = {"Authorization": f"Bearer {other_token}"}

    assert (await client.get(f"/api/v1/assets/{created['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/assets/{created['id']}", json={"name": "Hijacked"}, headers=other_h)
    ).status_code == 404
    assert (await client.delete(f"/api/v1/assets/{created['id']}", headers=other_h)).status_code == 404
    assert (
        await client.post(
            f"/api/v1/assets/{created['id']}/valuations",
            json={"value_minor": 1, "as_of": "2026-01-01"},
            headers=other_h,
        )
    ).status_code == 404
    assert (
        await client.get(f"/api/v1/assets/{created['id']}/valuations", headers=other_h)
    ).status_code == 404
    assert (
        await client.patch(
            f"/api/v1/assets/{created['id']}/valuations/{valuation['id']}",
            json={"value_minor": 1},
            headers=other_h,
        )
    ).status_code == 404
    lst = (await client.get("/api/v1/assets", headers=other_h)).json()
    assert all(a["id"] != created["id"] for a in lst["items"])


async def test_asset_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client)
    await _asset(client, h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "asset.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.asset.created" in templates


async def test_asset_updated_and_deleted_are_audited(client, initialized_instance, db):
    h = await _auth(client)
    created = await _asset(client, h)
    await client.patch(f"/api/v1/assets/{created['id']}", json={"name": "Renamed"}, headers=h)
    await client.delete(f"/api/v1/assets/{created['id']}", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "asset.updated" in actions
    assert "asset.deleted" in actions


async def test_asset_valuation_created_and_updated_are_audited(client, initialized_instance, db):
    h = await _auth(client)
    created = await _asset(client, h)
    valuation = (
        await client.post(
            f"/api/v1/assets/{created['id']}/valuations",
            json={"value_minor": 1000, "as_of": "2026-01-01"},
            headers=h,
        )
    ).json()
    await client.patch(
        f"/api/v1/assets/{created['id']}/valuations/{valuation['id']}",
        json={"value_minor": 1200},
        headers=h,
    )
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "asset.valuation.created" in actions
    assert "asset.valuation.updated" in actions
