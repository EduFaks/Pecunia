import uuid

import sqlalchemy as sa

from pecunia.models import PALETTE, ActivityEntry, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {"name": "Freelance", "kind": "income", "color": PALETTE[0], "icon": "wallet"}


async def _auth(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_create_category(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/categories", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Freelance"
    assert body["kind"] == "income"
    assert body["color"] == PALETTE[0]
    assert body["icon"] == "wallet"
    assert body["is_demo"] is False
    assert body["archived_at"] is None
    assert uuid.UUID(body["id"])


async def test_create_category_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/categories", json=NEW)
    assert resp.status_code == 401


async def test_invalid_kind_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/categories", json=NEW | {"kind": "mixed"}, headers=h)
    assert resp.status_code == 422


async def test_invalid_color_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/categories", json=NEW | {"color": "#ffffff"}, headers=h)
    assert resp.status_code == 422


async def test_invalid_icon_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/categories", json=NEW | {"icon": "not a valid icon!"}, headers=h)
    assert resp.status_code == 422


async def test_valid_icon_accepted(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/categories", json=NEW | {"icon": "wallet"}, headers=h)
    assert resp.status_code == 201
    assert resp.json()["icon"] == "wallet"


async def test_omitted_icon_allowed(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    body = NEW.copy()
    del body["icon"]
    resp = await client.post("/api/v1/categories", json=body, headers=h)
    assert resp.status_code == 201
    assert resp.json()["icon"] is None


async def test_list_and_get(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/categories", json=NEW, headers=h)).json()
    lst = (await client.get("/api/v1/categories", headers=h)).json()
    assert any(c["id"] == created["id"] for c in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/categories/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_list_pagination_orders_newest_first_with_string_cursor(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created_ids = []
    for i in range(3):
        c = (await client.post("/api/v1/categories", json=NEW | {"name": f"Cat{i}"}, headers=h)).json()
        created_ids.append(c["id"])

    # The workspace also carries its 11 real DEFAULT_CATEGORIES (older than
    # these 3, so newest-first sorts them after) — page only until the 3
    # just-created categories are collected, not until cursor is exhausted.
    seen = []
    cursor = None
    while len(seen) < len(created_ids):
        params = {"limit": 1, "cursor": cursor} if cursor is not None else {"limit": 1}
        page = (await client.get("/api/v1/categories", params=params, headers=h)).json()
        seen.extend(c["id"] for c in page["items"])
        cursor = page["next_cursor"]

    assert seen == list(reversed(created_ids))  # newest-first, not random UUID order


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.get(f"/api/v1/categories/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CATEGORY_NOT_FOUND"


async def test_update_category(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/categories", json=NEW, headers=h)).json()
    resp = await client.patch(
        f"/api/v1/categories/{created['id']}", json={"name": "Side Hustle"}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Side Hustle"
    assert body["kind"] == "income"  # untouched field preserved
    got = (await client.get(f"/api/v1/categories/{created['id']}", headers=h)).json()
    assert got["name"] == "Side Hustle"


async def test_update_category_invalid_color_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/categories", json=NEW, headers=h)).json()
    resp = await client.patch(
        f"/api/v1/categories/{created['id']}", json={"color": "#123456"}, headers=h
    )
    assert resp.status_code == 422


async def test_update_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.patch(f"/api/v1/categories/{uuid.uuid4()}", json={"name": "X"}, headers=h)
    assert resp.status_code == 404


async def test_archive(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    cat = (await client.post("/api/v1/categories", json=NEW, headers=h)).json()
    assert (await client.post(f"/api/v1/categories/{cat['id']}/archive", headers=h)).status_code == 204
    # archived categories excluded from the default list
    lst = (await client.get("/api/v1/categories", headers=h)).json()
    assert all(c["id"] != cat["id"] for c in lst["items"])
    # but still fetchable directly, and reflect archived_at
    got = (await client.get(f"/api/v1/categories/{cat['id']}", headers=h)).json()
    assert got["archived_at"] is not None
    # include_archived=true brings it back into the list
    lst_all = (await client.get("/api/v1/categories?include_archived=true", headers=h)).json()
    assert any(c["id"] == cat["id"] for c in lst_all["items"])


async def test_archive_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post(f"/api/v1/categories/{uuid.uuid4()}/archive", headers=h)
    assert resp.status_code == 404


async def test_archiving_category_leaves_transaction_category_id_intact(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    cat = (await client.post("/api/v1/categories", json=NEW | {"kind": "expense"}, headers=h)).json()
    acc = (
        await client.post(
            "/api/v1/accounts",
            json={"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 100000},
            headers=h,
        )
    ).json()
    tx = (
        await client.post(
            "/api/v1/transactions",
            json={
                "account_id": acc["id"],
                "category_id": cat["id"],
                "amount_minor": -100,
                "currency": "BRL",
                "description": "x",
                "occurred_on": "2026-09-11",
            },
            headers=h,
        )
    ).json()
    assert (await client.post(f"/api/v1/categories/{cat['id']}/archive", headers=h)).status_code == 204
    got = (await client.get(f"/api/v1/transactions/{tx['id']}", headers=h)).json()
    assert got["category_id"] == cat["id"]  # archive() sets archived_at, never nulls references


async def test_cross_workspace_access_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client, initialized_instance)
    cat = (await client.post("/api/v1/categories", json=NEW, headers=h)).json()

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

    assert (await client.get(f"/api/v1/categories/{cat['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/categories/{cat['id']}", json={"name": "Hijacked"}, headers=other_h)
    ).status_code == 404
    assert (
        await client.post(f"/api/v1/categories/{cat['id']}/archive", headers=other_h)
    ).status_code == 404
    # and the other workspace's list never sees it
    lst = (await client.get("/api/v1/categories", headers=other_h)).json()
    assert all(c["id"] != cat["id"] for c in lst["items"])


async def test_category_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    await client.post("/api/v1/categories", json=NEW, headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "category.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.category.created" in templates


async def test_category_updated_and_archived_are_audited(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    cat = (await client.post("/api/v1/categories", json=NEW, headers=h)).json()
    await client.patch(f"/api/v1/categories/{cat['id']}", json={"name": "Renamed"}, headers=h)
    await client.post(f"/api/v1/categories/{cat['id']}/archive", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "category.updated" in actions
    assert "category.archived" in actions
