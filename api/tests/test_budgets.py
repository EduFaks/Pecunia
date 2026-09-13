import uuid

import sqlalchemy as sa

from pecunia.models import PALETTE, ActivityEntry, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {"name": "Groceries", "category_id": None, "period": "monthly", "amount_minor": 50000, "currency": "BRL"}


async def _auth(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _category(client, h, **overrides):
    # A name distinct from every DEFAULT_CATEGORIES entry (services/setup.py
    # seeds those for the workspace) — the workspace already has a real
    # "Groceries"/expense category by the time these tests run, so reusing
    # that name here would collide on (workspace_id, name, kind).
    body = {"name": "Test Category", "kind": "expense", "color": PALETTE[0], "icon": None}
    body.update(overrides)
    return (await client.post("/api/v1/categories", json=body, headers=h)).json()


async def test_create_budget(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/budgets", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Groceries"
    assert body["category_id"] is None
    assert body["period"] == "monthly"
    assert body["amount_minor"] == 50000
    assert body["currency"] == "BRL"
    assert body["is_demo"] is False
    assert uuid.UUID(body["id"])


async def test_create_budget_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/budgets", json=NEW)
    assert resp.status_code == 401


async def test_create_budget_without_category(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/budgets", json=NEW | {"category_id": None}, headers=h)
    assert resp.status_code == 201
    assert resp.json()["category_id"] is None


async def test_create_budget_with_category_id(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    cat = await _category(client, h)
    resp = await client.post("/api/v1/budgets", json=NEW | {"category_id": cat["id"]}, headers=h)
    assert resp.status_code == 201
    assert resp.json()["category_id"] == cat["id"]


async def test_create_budget_with_category_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client, initialized_instance)

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
    other_cat = await _category(client, other_h)

    resp = await client.post("/api/v1/budgets", json=NEW | {"category_id": other_cat["id"]}, headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CATEGORY_NOT_FOUND"


async def test_update_budget_category_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/budgets", json=NEW, headers=h)).json()

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
    other_cat = await _category(client, other_h)

    resp = await client.patch(
        f"/api/v1/budgets/{created['id']}", json={"category_id": other_cat["id"]}, headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CATEGORY_NOT_FOUND"


async def test_list_and_get(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/budgets", json=NEW, headers=h)).json()
    lst = (await client.get("/api/v1/budgets", headers=h)).json()
    assert any(b["id"] == created["id"] for b in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/budgets/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_list_pagination_orders_newest_first_with_string_cursor(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created_ids = []
    for i in range(3):
        b = (await client.post("/api/v1/budgets", json=NEW | {"name": f"Budget{i}"}, headers=h)).json()
        created_ids.append(b["id"])

    seen = []
    cursor = None
    for _ in range(10):
        params = {"limit": 1}
        if cursor is not None:
            params["cursor"] = cursor
        page = (await client.get("/api/v1/budgets", params=params, headers=h)).json()
        seen.extend(b["id"] for b in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == list(reversed(created_ids))  # newest-first, not random UUID order


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.get(f"/api/v1/budgets/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "BUDGET_NOT_FOUND"


async def test_invalid_period_and_currency_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    assert (await client.post("/api/v1/budgets", json=NEW | {"period": "daily"}, headers=h)).status_code == 422
    assert (await client.post("/api/v1/budgets", json=NEW | {"currency": "brl"}, headers=h)).status_code == 422


async def test_invalid_amount_type_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/budgets", json=NEW | {"amount_minor": "not-a-number"}, headers=h)
    assert resp.status_code == 422


async def test_update_budget(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/budgets", json=NEW, headers=h)).json()
    resp = await client.patch(
        f"/api/v1/budgets/{created['id']}", json={"name": "Groceries Q3", "amount_minor": 60000}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Groceries Q3"
    assert body["amount_minor"] == 60000
    assert body["period"] == "monthly"  # untouched field preserved
    got = (await client.get(f"/api/v1/budgets/{created['id']}", headers=h)).json()
    assert got["name"] == "Groceries Q3"


async def test_update_budget_category_to_null(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/budgets", json=NEW, headers=h)).json()
    resp = await client.patch(f"/api/v1/budgets/{created['id']}", json={"category_id": None}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["category_id"] is None


async def test_update_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.patch(f"/api/v1/budgets/{uuid.uuid4()}", json={"name": "X"}, headers=h)
    assert resp.status_code == 404


async def test_delete_budget_is_hard_delete(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/budgets", json=NEW, headers=h)).json()
    resp = await client.delete(f"/api/v1/budgets/{created['id']}", headers=h)
    assert resp.status_code == 204
    got = await client.get(f"/api/v1/budgets/{created['id']}", headers=h)
    assert got.status_code == 404
    lst = (await client.get("/api/v1/budgets", headers=h)).json()
    assert all(b["id"] != created["id"] for b in lst["items"])


async def test_delete_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.delete(f"/api/v1/budgets/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404


async def test_cross_workspace_access_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client, initialized_instance)
    b = (await client.post("/api/v1/budgets", json=NEW, headers=h)).json()

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

    assert (await client.get(f"/api/v1/budgets/{b['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/budgets/{b['id']}", json={"name": "Hijacked"}, headers=other_h)
    ).status_code == 404
    assert (await client.delete(f"/api/v1/budgets/{b['id']}", headers=other_h)).status_code == 404
    # and the other workspace's list never sees it
    lst = (await client.get("/api/v1/budgets", headers=other_h)).json()
    assert all(b2["id"] != b["id"] for b2 in lst["items"])


async def test_budget_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    await client.post("/api/v1/budgets", json=NEW, headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "budget.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.budget.created" in templates


async def test_budget_updated_and_deleted_are_audited(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    b = (await client.post("/api/v1/budgets", json=NEW, headers=h)).json()
    await client.patch(f"/api/v1/budgets/{b['id']}", json={"name": "Renamed"}, headers=h)
    await client.delete(f"/api/v1/budgets/{b['id']}", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "budget.updated" in actions
    assert "budget.deleted" in actions
