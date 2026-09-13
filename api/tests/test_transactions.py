import uuid

import sqlalchemy as sa

from pecunia.models import PALETTE, ActivityEntry, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {"Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"}


async def _account(client, h, **overrides):
    body = {"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 100000}
    body.update(overrides)
    return (await client.post("/api/v1/accounts", json=body, headers=h)).json()


async def _category(client, h, **overrides):
    # A name distinct from every DEFAULT_CATEGORIES entry (services/setup.py
    # seeds those for the workspace) — the workspace already has a real
    # "Groceries"/expense category by the time these tests run, so reusing
    # that name here would collide on (workspace_id, name, kind).
    body = {"name": "Test Category", "kind": "expense", "color": PALETTE[0], "icon": None}
    body.update(overrides)
    return (await client.post("/api/v1/categories", json=body, headers=h)).json()


async def _contact(client, h, **overrides):
    body = {"name": "Green Valley Market"}
    body.update(overrides)
    return (await client.post("/api/v1/contacts", json=body, headers=h)).json()


async def _project(client, h, **overrides):
    body = {"name": "Sim Rig", "currency": "BRL", "target_amount_minor": None}
    body.update(overrides)
    return (await client.post("/api/v1/projects", json=body, headers=h)).json()


def _tx_body(account_id, **overrides):
    body = {
        "account_id": account_id,
        "amount_minor": -8499,
        "currency": "BRL",
        "description": "Apple Store",
        "occurred_on": "2026-09-11",
    }
    body.update(overrides)
    return body


async def test_create_transaction_affects_balance(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = {"account_id": acc["id"], "amount_minor": -8499, "currency": "BRL",
          "description": "Apple Store", "occurred_on": "2026-09-11"}
    resp = await client.post("/api/v1/transactions", json=tx, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["amount_minor"] == -8499
    assert body["currency"] == "BRL"
    assert body["description"] == "Apple Store"
    assert body["deleted_at"] is None
    assert uuid.UUID(body["id"])
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["balance_minor"] == 100000 - 8499


async def test_soft_delete_and_restore_roundtrip_balance(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions",
          json={"account_id": acc["id"], "amount_minor": -5000, "currency": "BRL",
                "description": "x", "occurred_on": "2026-09-11"}, headers=h)).json()
    del_resp = await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)
    assert del_resp.status_code == 204
    assert (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()["balance_minor"] == 100000
    restore_resp = await client.post(f"/api/v1/transactions/{tx['id']}/restore", headers=h)
    assert restore_resp.status_code == 204
    assert (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()["balance_minor"] == 95000


async def test_deleted_excluded_from_list(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions",
          json={"account_id": acc["id"], "amount_minor": -5000, "currency": "BRL",
                "description": "x", "occurred_on": "2026-09-11"}, headers=h)).json()
    await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)
    lst = (await client.get(f"/api/v1/transactions?account_id={acc['id']}", headers=h)).json()
    assert all(t["id"] != tx["id"] for t in lst["items"])


async def test_amount_over_int64_bounds_rejected_as_422_not_500(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], amount_minor=2**63),  # one past bigint max
        headers=h,
    )
    assert resp.status_code == 422


async def test_currency_mismatch_rejected(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post("/api/v1/transactions",
        json={"account_id": acc["id"], "amount_minor": -1, "currency": "USD",
              "description": "x", "occurred_on": "2026-09-11"}, headers=h)
    assert resp.status_code == 422


async def test_cannot_touch_other_workspace_account(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post("/api/v1/transactions",
        json={"account_id": str(uuid.uuid4()), "amount_minor": -1, "currency": "BRL",
              "description": "x", "occurred_on": "2026-09-11"}, headers=h)
    assert resp.status_code == 404


async def test_create_transaction_with_category_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    resp = await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], category_id=cat["id"]), headers=h
    )
    assert resp.status_code == 201
    assert resp.json()["category_id"] == cat["id"]


async def test_create_transaction_with_category_defaults_to_null(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)
    assert resp.status_code == 201
    assert resp.json()["category_id"] is None


async def test_create_transaction_with_category_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    acc = await _account(client, h)

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

    resp = await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], category_id=other_cat["id"]), headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CATEGORY_NOT_FOUND"


async def test_create_transaction_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/transactions", json=_tx_body(str(uuid.uuid4())))
    assert resp.status_code == 401


async def test_list_filtered_by_account(client, initialized_instance):
    h = await _auth(client)
    acc1 = await _account(client, h, name="One")
    acc2 = await _account(client, h, name="Two")
    tx1 = (await client.post("/api/v1/transactions", json=_tx_body(acc1["id"]), headers=h)).json()
    await client.post("/api/v1/transactions", json=_tx_body(acc2["id"]), headers=h)
    lst = (await client.get(f"/api/v1/transactions?account_id={acc1['id']}", headers=h)).json()
    assert [t["id"] for t in lst["items"]] == [tx1["id"]]


async def test_list_filtered_by_category_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat1 = await _category(client, h, name="Test Category")
    cat2 = await _category(client, h, name="Test Category 2")
    tx1 = (
        await client.post("/api/v1/transactions", json=_tx_body(acc["id"], category_id=cat1["id"]), headers=h)
    ).json()
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], category_id=cat2["id"]), headers=h)
    lst = (await client.get(f"/api/v1/transactions?category_id={cat1['id']}", headers=h)).json()
    assert [t["id"] for t in lst["items"]] == [tx1["id"]]


async def test_list_pagination_orders_by_occurred_on_desc(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    dates = ["2026-09-01", "2026-09-05", "2026-09-03"]
    created_ids = []
    for i, d in enumerate(dates):
        tx = (await client.post(
            "/api/v1/transactions",
            json=_tx_body(acc["id"], description=f"t{i}", occurred_on=d),
            headers=h,
        )).json()
        created_ids.append((d, tx["id"]))
    expected_order = [i for _, i in sorted(created_ids, key=lambda p: p[0], reverse=True)]

    seen = []
    cursor = None
    for _ in range(10):
        params = {"limit": 1, "account_id": acc["id"]}
        if cursor is not None:
            params["cursor"] = cursor
        page = (await client.get("/api/v1/transactions", params=params, headers=h)).json()
        seen.extend(t["id"] for t in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == expected_order


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/transactions/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "TRANSACTION_NOT_FOUND"


async def test_update_transaction(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()
    resp = await client.patch(
        f"/api/v1/transactions/{tx['id']}", json={"description": "Renamed", "amount_minor": -100}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["description"] == "Renamed"
    assert body["amount_minor"] == -100
    assert body["currency"] == "BRL"  # untouched field preserved
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["balance_minor"] == 100000 - 100


async def test_update_currency_mismatch_rejected(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()
    resp = await client.patch(f"/api/v1/transactions/{tx['id']}", json={"currency": "USD"}, headers=h)
    assert resp.status_code == 422


async def test_update_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.patch(f"/api/v1/transactions/{uuid.uuid4()}", json={"description": "x"}, headers=h)
    assert resp.status_code == 404


async def test_update_account_id_to_account_not_in_caller_workspace_returns_404(
    client, initialized_instance
):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()
    # A PATCH that tries to hijack the transaction onto an account_id that
    # isn't one of the caller's own accounts must 404, not silently succeed
    # or leak whether that id exists in some other workspace.
    resp = await client.patch(
        f"/api/v1/transactions/{tx['id']}", json={"account_id": str(uuid.uuid4())}, headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ACCOUNT_NOT_FOUND"
    # untouched: the transaction still points at its original account
    got = (await client.get(f"/api/v1/transactions/{tx['id']}", headers=h)).json()
    assert got["account_id"] == acc["id"]


async def test_update_transaction_category_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()
    resp = await client.patch(
        f"/api/v1/transactions/{tx['id']}", json={"category_id": cat["id"]}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["category_id"] == cat["id"]


async def test_update_transaction_category_id_to_null(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    tx = (
        await client.post("/api/v1/transactions", json=_tx_body(acc["id"], category_id=cat["id"]), headers=h)
    ).json()
    resp = await client.patch(f"/api/v1/transactions/{tx['id']}", json={"category_id": None}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["category_id"] is None


async def test_update_transaction_category_id_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()

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
        f"/api/v1/transactions/{tx['id']}", json={"category_id": other_cat["id"]}, headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CATEGORY_NOT_FOUND"
    # untouched: the transaction still carries no category
    got = (await client.get(f"/api/v1/transactions/{tx['id']}", headers=h)).json()
    assert got["category_id"] is None


async def test_delete_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.delete(f"/api/v1/transactions/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404


async def test_restore_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(f"/api/v1/transactions/{uuid.uuid4()}/restore", headers=h)
    assert resp.status_code == 404


async def test_cross_workspace_transaction_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()

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

    assert (await client.get(f"/api/v1/transactions/{tx['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/transactions/{tx['id']}", json={"description": "Hijacked"}, headers=other_h)
    ).status_code == 404
    assert (await client.delete(f"/api/v1/transactions/{tx['id']}", headers=other_h)).status_code == 404
    assert (await client.post(f"/api/v1/transactions/{tx['id']}/restore", headers=other_h)).status_code == 404
    lst = (await client.get("/api/v1/transactions", headers=other_h)).json()
    assert all(t["id"] != tx["id"] for t in lst["items"])


async def test_transaction_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client)
    acc = await _account(client, h)
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "transaction.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.transaction.created" in templates


async def test_transaction_deleted_and_restored_are_audited(client, initialized_instance, db):
    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()
    await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)
    await client.post(f"/api/v1/transactions/{tx['id']}/restore", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "transaction.deleted" in actions
    assert "transaction.restored" in actions


async def test_create_transaction_with_contact_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    contact = await _contact(client, h)
    resp = await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], contact_id=contact["id"]), headers=h
    )
    assert resp.status_code == 201
    assert resp.json()["contact_id"] == contact["id"]


async def test_create_transaction_with_contact_defaults_to_null(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)
    assert resp.status_code == 201
    assert resp.json()["contact_id"] is None


async def test_create_transaction_with_contact_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    acc = await _account(client, h)

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
    other_contact = await _contact(client, other_h)

    resp = await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], contact_id=other_contact["id"]), headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CONTACT_NOT_FOUND"


async def test_list_filtered_by_contact_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    contact1 = await _contact(client, h, name="Contact One")
    contact2 = await _contact(client, h, name="Contact Two")
    tx1 = (
        await client.post("/api/v1/transactions", json=_tx_body(acc["id"], contact_id=contact1["id"]), headers=h)
    ).json()
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], contact_id=contact2["id"]), headers=h)
    lst = (await client.get(f"/api/v1/transactions?contact_id={contact1['id']}", headers=h)).json()
    assert [t["id"] for t in lst["items"]] == [tx1["id"]]


async def test_contact_default_category_applied_when_no_category(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    contact = await _contact(client, h, default_category_id=cat["id"])
    resp = await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], contact_id=contact["id"]), headers=h
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["contact_id"] == contact["id"]
    assert body["category_id"] == cat["id"]  # inherited the contact's default


async def test_explicit_category_overrides_contact_default(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    default_cat = await _category(client, h, name="Default Cat")
    explicit_cat = await _category(client, h, name="Explicit Cat")
    contact = await _contact(client, h, default_category_id=default_cat["id"])
    resp = await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], contact_id=contact["id"], category_id=explicit_cat["id"]),
        headers=h,
    )
    assert resp.status_code == 201
    # the explicit category wins; the contact default does NOT override it
    assert resp.json()["category_id"] == explicit_cat["id"]


async def test_update_contact_id_does_not_auto_apply_default_category(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    contact = await _contact(client, h, default_category_id=cat["id"])
    # a transaction created with no contact and no category
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()
    assert tx["category_id"] is None
    # attaching the contact via PATCH must NOT auto-apply the contact's default category
    resp = await client.patch(
        f"/api/v1/transactions/{tx['id']}", json={"contact_id": contact["id"]}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["contact_id"] == contact["id"]
    assert body["category_id"] is None  # update never auto-applies


async def test_archiving_contact_leaves_transaction_contact_id_intact(client, initialized_instance):
    # archive() (mirroring CategoryService.archive) only sets archived_at; it
    # never deletes the contact, so the ON DELETE SET NULL from Task 1 does not
    # fire and the transaction keeps its contact_id. The SET NULL cascade is
    # exercised on a real DELETE by test_migration_0014. This mirrors
    # test_archiving_category_leaves_transaction_category_id_intact exactly.
    h = await _auth(client)
    acc = await _account(client, h)
    contact = await _contact(client, h)
    tx = (
        await client.post("/api/v1/transactions", json=_tx_body(acc["id"], contact_id=contact["id"]), headers=h)
    ).json()
    assert (await client.post(f"/api/v1/contacts/{contact['id']}/archive", headers=h)).status_code == 204
    got = (await client.get(f"/api/v1/transactions/{tx['id']}", headers=h)).json()
    assert got["id"] == tx["id"]  # transaction survives
    assert got["contact_id"] == contact["id"]  # archive doesn't null references


async def test_create_transaction_with_project_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h)
    resp = await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], project_id=project["id"]), headers=h
    )
    assert resp.status_code == 201
    assert resp.json()["project_id"] == project["id"]


async def test_create_transaction_with_project_defaults_to_null(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)
    assert resp.status_code == 201
    assert resp.json()["project_id"] is None


async def test_create_transaction_with_project_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    acc = await _account(client, h)

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
    other_project = await _project(client, other_h)

    resp = await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], project_id=other_project["id"]), headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "PROJECT_NOT_FOUND"


async def test_update_transaction_project_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()
    resp = await client.patch(
        f"/api/v1/transactions/{tx['id']}", json={"project_id": project["id"]}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["project_id"] == project["id"]


async def test_update_transaction_project_id_to_null(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h)
    tx = (
        await client.post("/api/v1/transactions", json=_tx_body(acc["id"], project_id=project["id"]), headers=h)
    ).json()
    resp = await client.patch(f"/api/v1/transactions/{tx['id']}", json={"project_id": None}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["project_id"] is None


async def test_update_transaction_project_from_other_workspace_rejected(
    client, initialized_instance, user_factory, db
):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    acc = await _account(client, h)
    tx = (await client.post("/api/v1/transactions", json=_tx_body(acc["id"]), headers=h)).json()

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
    other_project = await _project(client, other_h)

    resp = await client.patch(
        f"/api/v1/transactions/{tx['id']}", json={"project_id": other_project["id"]}, headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "PROJECT_NOT_FOUND"
    got = (await client.get(f"/api/v1/transactions/{tx['id']}", headers=h)).json()
    assert got["project_id"] is None  # untouched


async def test_list_filtered_by_project_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    p1 = await _project(client, h, name="P1")
    p2 = await _project(client, h, name="P2")
    tx1 = (
        await client.post("/api/v1/transactions", json=_tx_body(acc["id"], project_id=p1["id"]), headers=h)
    ).json()
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], project_id=p2["id"]), headers=h)
    lst = (await client.get(f"/api/v1/transactions?project_id={p1['id']}", headers=h)).json()
    assert [t["id"] for t in lst["items"]] == [tx1["id"]]


async def test_multiple_transactions_sum_into_balance(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=5000), headers=h)
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=-2000), headers=h)
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["balance_minor"] == 100000 + 5000 - 2000


# --- search + date/amount/type filters (Track L, Task 1) --------------------


async def test_list_search_q_matches_description_case_insensitively(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    lower = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="coffee shop"), headers=h
    )).json()
    upper = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="COFFEE beans"), headers=h
    )).json()
    await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="Grocery run"), headers=h
    )
    lst = (await client.get("/api/v1/transactions", params={"q": "coffee"}, headers=h)).json()
    assert {t["id"] for t in lst["items"]} == {lower["id"], upper["id"]}


async def test_list_search_q_blank_is_ignored(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], description="Alpha"), headers=h)
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], description="Beta"), headers=h)
    lst = (await client.get("/api/v1/transactions", params={"q": "   "}, headers=h)).json()
    assert len(lst["items"]) == 2


async def test_list_search_q_escapes_percent_literal(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    with_percent = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="50% off"), headers=h
    )).json()
    without_percent = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="discount"), headers=h
    )).json()
    # Searching for "50%" should match only the transaction with literal "%"
    lst = (await client.get("/api/v1/transactions", params={"q": "50%"}, headers=h)).json()
    assert {t["id"] for t in lst["items"]} == {with_percent["id"]}
    # Unrelated search should not match
    lst = (await client.get("/api/v1/transactions", params={"q": "discount"}, headers=h)).json()
    assert {t["id"] for t in lst["items"]} == {without_percent["id"]}


async def test_list_search_q_escapes_underscore_literal(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    with_underscore = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="test_case"), headers=h
    )).json()
    without_underscore = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="testcase"), headers=h
    )).json()
    # Searching for "test_case" should match only the transaction with literal "_"
    lst = (await client.get("/api/v1/transactions", params={"q": "test_case"}, headers=h)).json()
    assert {t["id"] for t in lst["items"]} == {with_underscore["id"]}
    # Searching for "testcase" should not match the underscore variant (literal match required)
    lst = (await client.get("/api/v1/transactions", params={"q": "testcase"}, headers=h)).json()
    assert {t["id"] for t in lst["items"]} == {without_underscore["id"]}


async def test_list_filtered_by_date_range_inclusive(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    before = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], occurred_on="2026-08-31"), headers=h
    )).json()
    lo = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], occurred_on="2026-09-01"), headers=h
    )).json()
    hi = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], occurred_on="2026-09-05"), headers=h
    )).json()
    after = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], occurred_on="2026-09-06"), headers=h
    )).json()
    lst = (await client.get(
        "/api/v1/transactions", params={"from": "2026-09-01", "to": "2026-09-05"}, headers=h
    )).json()
    ids = {t["id"] for t in lst["items"]}
    assert ids == {lo["id"], hi["id"]}
    assert before["id"] not in ids and after["id"] not in ids


async def test_list_filtered_by_amount_magnitude_range(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    expense = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=-5000), headers=h
    )).json()
    income = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=5000), headers=h
    )).json()
    big = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=-20000), headers=h
    )).json()
    lst = (await client.get(
        "/api/v1/transactions",
        params={"min_amount_minor": 1000, "max_amount_minor": 6000},
        headers=h,
    )).json()
    ids = {t["id"] for t in lst["items"]}
    # Both the −5000 expense and the +5000 income match on magnitude; −20000 excluded.
    assert ids == {expense["id"], income["id"]}
    assert big["id"] not in ids


async def test_list_amount_range_min_greater_than_max_is_empty(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=-5000), headers=h)
    lst = (await client.get(
        "/api/v1/transactions",
        params={"min_amount_minor": 6000, "max_amount_minor": 1000},
        headers=h,
    )).json()
    assert lst["items"] == []


async def _transfer(client, h, from_id, to_id, **overrides):
    body = {
        "from_account_id": from_id,
        "to_account_id": to_id,
        "amount_minor": 3000,
        "currency": "BRL",
        "description": "Move money",
        "occurred_on": "2026-09-11",
    }
    body.update(overrides)
    return (await client.post("/api/v1/transfers", json=body, headers=h)).json()


async def test_list_type_income_excludes_negatives_and_transfer_legs(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h, name="A")
    acc2 = await _account(client, h, name="B")
    income = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=5000), headers=h
    )).json()
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=-5000), headers=h)
    await _transfer(client, h, acc["id"], acc2["id"])
    lst = (await client.get("/api/v1/transactions", params={"type": "income"}, headers=h)).json()
    assert [t["id"] for t in lst["items"]] == [income["id"]]


async def test_list_type_expense_excludes_positives_and_transfer_legs(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h, name="A")
    acc2 = await _account(client, h, name="B")
    await client.post("/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=5000), headers=h)
    expense = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=-5000), headers=h
    )).json()
    await _transfer(client, h, acc["id"], acc2["id"])
    lst = (await client.get("/api/v1/transactions", params={"type": "expense"}, headers=h)).json()
    assert [t["id"] for t in lst["items"]] == [expense["id"]]


async def test_list_type_transfer_returns_only_legs(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h, name="A")
    acc2 = await _account(client, h, name="B")
    plain_income = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=5000), headers=h
    )).json()
    plain_expense = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], amount_minor=-5000), headers=h
    )).json()
    await _transfer(client, h, acc["id"], acc2["id"])
    lst = (await client.get("/api/v1/transactions", params={"type": "transfer"}, headers=h)).json()
    # Two legs, both carrying transfer_id; the plain income/expense excluded.
    assert len(lst["items"]) == 2
    assert all(t["transfer_id"] is not None for t in lst["items"])
    ids = {t["id"] for t in lst["items"]}
    assert plain_income["id"] not in ids and plain_expense["id"] not in ids


async def test_list_filters_and_together(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    match = (await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], amount_minor=5000, description="Salary payout", occurred_on="2026-09-03"),
        headers=h,
    )).json()
    # Wrong sign (expense) but matching q + date.
    await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], amount_minor=-5000, description="Salary refund", occurred_on="2026-09-03"),
        headers=h,
    )
    # Right sign + q but out of date range.
    await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], amount_minor=5000, description="Salary early", occurred_on="2026-08-01"),
        headers=h,
    )
    # Right sign + date but q does not match.
    await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], amount_minor=5000, description="Bonus", occurred_on="2026-09-03"),
        headers=h,
    )
    lst = (await client.get(
        "/api/v1/transactions",
        params={"q": "salary", "type": "income", "from": "2026-09-01", "to": "2026-09-30"},
        headers=h,
    )).json()
    assert [t["id"] for t in lst["items"]] == [match["id"]]


async def test_list_new_filters_combine_with_contact_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    contact = await _contact(client, h, name="Vendor")
    match = (await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], contact_id=contact["id"], description="Coffee with vendor"),
        headers=h,
    )).json()
    # Same contact, but q won't match.
    await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], contact_id=contact["id"], description="Lunch"),
        headers=h,
    )
    # Matching q, but no contact.
    await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], description="Coffee alone"),
        headers=h,
    )
    lst = (await client.get(
        "/api/v1/transactions",
        params={"contact_id": contact["id"], "q": "coffee"},
        headers=h,
    )).json()
    assert [t["id"] for t in lst["items"]] == [match["id"]]


async def test_list_keyset_pagination_stable_under_filter(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    expense_ids = []
    for i, d in enumerate(["2026-09-01", "2026-09-02", "2026-09-03"]):
        tx = (await client.post(
            "/api/v1/transactions",
            json=_tx_body(acc["id"], amount_minor=-1000, description=f"e{i}", occurred_on=d),
            headers=h,
        )).json()
        expense_ids.append((d, tx["id"]))
    # An income row that must never appear under type=expense.
    await client.post(
        "/api/v1/transactions",
        json=_tx_body(acc["id"], amount_minor=5000, description="inc", occurred_on="2026-09-04"),
        headers=h,
    )
    expected = [i for _, i in sorted(expense_ids, key=lambda p: p[0], reverse=True)]

    seen = []
    cursor = None
    saw_cursor = False
    for _ in range(10):
        params = {"limit": 2, "type": "expense"}
        if cursor is not None:
            params["cursor"] = cursor
        page = (await client.get("/api/v1/transactions", params=params, headers=h)).json()
        seen.extend(t["id"] for t in page["items"])
        cursor = page["next_cursor"]
        if cursor is not None:
            saw_cursor = True
        else:
            break
    assert seen == expected  # all three expenses, in keyset order, income excluded
    assert saw_cursor  # page-size boundary produced a next_cursor


async def test_list_search_is_workspace_scoped(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    acc = await _account(client, h)
    mine = (await client.post(
        "/api/v1/transactions", json=_tx_body(acc["id"], description="ZebraToken purchase"), headers=h
    )).json()

    other_user = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    await db.commit()
    other_h = {
        "Authorization": "Bearer "
        + (await client.post(
            "/api/v1/auth/login",
            json={"email": "other@example.com", "password": "correct horse battery staple"},
        )).json()["access_token"]
    }
    other_acc = await _account(client, other_h, name="Theirs")
    theirs = (await client.post(
        "/api/v1/transactions", json=_tx_body(other_acc["id"], description="ZebraToken purchase"), headers=other_h
    )).json()

    mine_lst = (await client.get("/api/v1/transactions", params={"q": "zebratoken"}, headers=h)).json()
    theirs_lst = (await client.get("/api/v1/transactions", params={"q": "zebratoken"}, headers=other_h)).json()
    assert [t["id"] for t in mine_lst["items"]] == [mine["id"]]
    assert [t["id"] for t in theirs_lst["items"]] == [theirs["id"]]
