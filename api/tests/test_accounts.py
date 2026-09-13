import uuid

import sqlalchemy as sa

from pecunia.models import ActivityEntry, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 100000}


async def _auth(client, initialized_instance):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_create_account(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post("/api/v1/accounts", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Checking"
    assert body["type"] == "checking"
    assert body["currency"] == "BRL"
    assert body["initial_balance_minor"] == 100000
    assert body["balance_minor"] == 100000  # no transactions yet
    assert body["is_demo"] is False
    assert body["archived_at"] is None
    assert uuid.UUID(body["id"])


async def test_create_account_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/accounts", json=NEW)
    assert resp.status_code == 401


async def test_list_and_get(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    lst = (await client.get("/api/v1/accounts", headers=h)).json()
    assert any(a["id"] == created["id"] for a in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/accounts/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_list_pagination_orders_newest_first_with_string_cursor(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created_ids = []
    for i in range(3):
        acc = (await client.post("/api/v1/accounts", json=NEW | {"name": f"Acc{i}"}, headers=h)).json()
        created_ids.append(acc["id"])

    seen = []
    cursor = None
    for _ in range(10):
        params = {"limit": 1}
        if cursor is not None:
            import base64

            assert isinstance(cursor, str)
            # opaque, URL-safe base64 keyset cursor (not a bare id); decodes to
            # the internal "{created_at}|{id}" keyset form
            assert "|" in base64.urlsafe_b64decode(cursor.encode()).decode()
            params["cursor"] = cursor
        # httpx encodes `params` properly (the cursor's "+" offset must not become a space)
        page = (await client.get("/api/v1/accounts", params=params, headers=h)).json()
        seen.extend(a["id"] for a in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == list(reversed(created_ids))  # newest-first, not random UUID order


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.get(f"/api/v1/accounts/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ACCOUNT_NOT_FOUND"


async def test_invalid_type_and_currency_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    assert (await client.post("/api/v1/accounts", json=NEW | {"type": "mattress"}, headers=h)).status_code == 422
    assert (await client.post("/api/v1/accounts", json=NEW | {"currency": "brl"}, headers=h)).status_code == 422


async def test_invalid_balance_type_rejected(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post(
        "/api/v1/accounts", json=NEW | {"initial_balance_minor": "not-a-number"}, headers=h
    )
    assert resp.status_code == 422


async def test_update_account(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    created = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    resp = await client.patch(
        f"/api/v1/accounts/{created['id']}", json={"name": "Main Checking"}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Main Checking"
    assert body["type"] == "checking"  # untouched field preserved
    # confirmed via GET too
    got = (await client.get(f"/api/v1/accounts/{created['id']}", headers=h)).json()
    assert got["name"] == "Main Checking"


async def test_update_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.patch(f"/api/v1/accounts/{uuid.uuid4()}", json={"name": "X"}, headers=h)
    assert resp.status_code == 404


async def test_archive(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    acc = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    assert (await client.post(f"/api/v1/accounts/{acc['id']}/archive", headers=h)).status_code == 204
    # archived accounts excluded from the default list
    lst = (await client.get("/api/v1/accounts", headers=h)).json()
    assert all(a["id"] != acc["id"] for a in lst["items"])
    # but still fetchable directly, and reflect archived_at
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["archived_at"] is not None
    # include_archived=true brings it back into the list
    lst_all = (await client.get("/api/v1/accounts?include_archived=true", headers=h)).json()
    assert any(a["id"] == acc["id"] for a in lst_all["items"])


async def test_currency_change_rejected_when_account_has_transactions(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    acc = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    await client.post(
        "/api/v1/transactions",
        json={
            "account_id": acc["id"],
            "amount_minor": -100,
            "currency": "BRL",
            "description": "x",
            "occurred_on": "2026-09-11",
        },
        headers=h,
    )
    resp = await client.patch(f"/api/v1/accounts/{acc['id']}", json={"currency": "USD"}, headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "ACCOUNT_HAS_TRANSACTIONS"
    # untouched: the account still carries its original currency
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["currency"] == "BRL"


async def test_currency_change_rejected_even_when_only_transaction_is_deleted(
    client, initialized_instance
):
    h = await _auth(client, initialized_instance)
    acc = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    tx = (
        await client.post(
            "/api/v1/transactions",
            json={
                "account_id": acc["id"],
                "amount_minor": -100,
                "currency": "BRL",
                "description": "x",
                "occurred_on": "2026-09-11",
            },
            headers=h,
        )
    ).json()
    await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)
    # the transaction row still exists (soft delete) — currency change must
    # still be rejected, since a future restore would corrupt balance()
    resp = await client.patch(f"/api/v1/accounts/{acc['id']}", json={"currency": "USD"}, headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "ACCOUNT_HAS_TRANSACTIONS"


async def test_currency_change_allowed_when_account_has_no_transactions(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    acc = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    resp = await client.patch(f"/api/v1/accounts/{acc['id']}", json={"currency": "USD"}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["currency"] == "USD"


async def test_archive_missing_returns_404(client, initialized_instance):
    h = await _auth(client, initialized_instance)
    resp = await client.post(f"/api/v1/accounts/{uuid.uuid4()}/archive", headers=h)
    assert resp.status_code == 404


async def test_cross_workspace_access_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client, initialized_instance)
    acc = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()

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

    assert (await client.get(f"/api/v1/accounts/{acc['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/accounts/{acc['id']}", json={"name": "Hijacked"}, headers=other_h)
    ).status_code == 404
    assert (
        await client.post(f"/api/v1/accounts/{acc['id']}/archive", headers=other_h)
    ).status_code == 404
    # and the other workspace's list never sees it
    lst = (await client.get("/api/v1/accounts", headers=other_h)).json()
    assert all(a["id"] != acc["id"] for a in lst["items"])


async def test_account_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    await client.post("/api/v1/accounts", json=NEW, headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "account.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.account.created" in templates


async def test_account_updated_and_archived_are_audited(client, initialized_instance, db):
    h = await _auth(client, initialized_instance)
    acc = (await client.post("/api/v1/accounts", json=NEW, headers=h)).json()
    await client.patch(f"/api/v1/accounts/{acc['id']}", json={"name": "Renamed"}, headers=h)
    await client.post(f"/api/v1/accounts/{acc['id']}/archive", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "account.updated" in actions
    assert "account.archived" in actions
