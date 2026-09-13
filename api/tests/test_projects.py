import uuid

import sqlalchemy as sa

from pecunia.models import ActivityEntry, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {"Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"}


async def _project(client, h, **overrides):
    body = {"name": "Roof Repair", "currency": "BRL", "target_amount_minor": 100000}
    body.update(overrides)
    return (await client.post("/api/v1/projects", json=body, headers=h)).json()


async def _account(client, h, **overrides):
    body = {"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 100000}
    body.update(overrides)
    return (await client.post("/api/v1/accounts", json=body, headers=h)).json()


async def _tx(client, h, account_id, **overrides):
    body = {
        "account_id": account_id,
        "amount_minor": -5000,
        "currency": "BRL",
        "description": "Parts",
        "occurred_on": "2026-09-11",
    }
    body.update(overrides)
    return (await client.post("/api/v1/transactions", json=body, headers=h)).json()


async def test_create_project(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Roof Repair", "currency": "BRL", "target_amount_minor": 100000},
        headers=h,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Roof Repair"
    assert body["currency"] == "BRL"
    assert body["target_amount_minor"] == 100000
    assert body["status"] == "active"
    assert body["planned_minor"] == 0
    assert body["actual_minor"] == 0
    assert body["type"] == "spending"  # default
    assert body["is_demo"] is False
    assert uuid.UUID(body["id"])


async def test_create_saving_project_persists_type(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Emergency Fund", "currency": "BRL", "type": "saving"},
        headers=h,
    )
    assert resp.status_code == 201
    assert resp.json()["type"] == "saving"
    got = (await client.get(f"/api/v1/projects/{resp.json()['id']}", headers=h)).json()
    assert got["type"] == "saving"


async def test_update_project_type(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    resp = await client.patch(
        f"/api/v1/projects/{created['id']}", json={"type": "saving"}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["type"] == "saving"


async def test_create_invalid_type_rejected(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "X", "currency": "BRL", "type": "bogus"},
        headers=h,
    )
    assert resp.status_code == 422


async def test_create_project_without_target(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post("/api/v1/projects", json={"name": "Rainy Day", "currency": "BRL"}, headers=h)
    assert resp.status_code == 201
    assert resp.json()["target_amount_minor"] is None


async def test_create_project_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/projects", json={"name": "X", "currency": "BRL"})
    assert resp.status_code == 401


async def test_list_and_get(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    lst = (await client.get("/api/v1/projects", headers=h)).json()
    assert any(p["id"] == created["id"] for p in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/projects/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/projects/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "PROJECT_NOT_FOUND"


async def test_update_project(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    resp = await client.patch(
        f"/api/v1/projects/{created['id']}", json={"name": "New Roof"}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "New Roof"
    assert body["currency"] == "BRL"  # untouched field preserved
    got = (await client.get(f"/api/v1/projects/{created['id']}", headers=h)).json()
    assert got["name"] == "New Roof"


async def test_update_status(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    resp = await client.patch(
        f"/api/v1/projects/{created['id']}", json={"status": "completed"}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "completed"


async def test_update_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.patch(f"/api/v1/projects/{uuid.uuid4()}", json={"name": "X"}, headers=h)
    assert resp.status_code == 404


async def test_delete_project_is_hard_delete(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    resp = await client.delete(f"/api/v1/projects/{created['id']}", headers=h)
    assert resp.status_code == 204
    got = await client.get(f"/api/v1/projects/{created['id']}", headers=h)
    assert got.status_code == 404
    lst = (await client.get("/api/v1/projects", headers=h)).json()
    assert all(p["id"] != created["id"] for p in lst["items"])


async def test_delete_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.delete(f"/api/v1/projects/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404


async def test_add_items_and_planned_minor_sums(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h, target_amount_minor=None)
    await client.post(
        f"/api/v1/projects/{created['id']}/items", json={"name": "Tiles", "amount_minor": 500}, headers=h
    )
    await client.post(
        f"/api/v1/projects/{created['id']}/items", json={"name": "Labor", "amount_minor": 300}, headers=h
    )
    got = (await client.get(f"/api/v1/projects/{created['id']}", headers=h)).json()
    assert got["planned_minor"] == 800
    assert got["actual_minor"] == 0  # planned parts alone don't move actual


async def test_add_item_returns_created_item(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    resp = await client.post(
        f"/api/v1/projects/{created['id']}/items", json={"name": "Tiles", "amount_minor": 500}, headers=h
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Tiles"
    assert body["amount_minor"] == 500
    assert body["project_id"] == created["id"]
    assert body["transaction_id"] is None  # unattached part
    assert body["actual_minor"] is None  # no actual cost until a tx is attached
    assert body["is_demo"] is False
    assert uuid.UUID(body["id"])


async def test_add_item_to_missing_project_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        f"/api/v1/projects/{uuid.uuid4()}/items", json={"name": "Tiles", "amount_minor": 500}, headers=h
    )
    assert resp.status_code == 404


async def test_list_items(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    item = (
        await client.post(
            f"/api/v1/projects/{created['id']}/items", json={"name": "Tiles", "amount_minor": 500}, headers=h
        )
    ).json()
    lst = (await client.get(f"/api/v1/projects/{created['id']}/items", headers=h)).json()
    assert any(i["id"] == item["id"] for i in lst["items"])


async def test_update_item(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h, target_amount_minor=None)
    item = (
        await client.post(
            f"/api/v1/projects/{created['id']}/items", json={"name": "Tiles", "amount_minor": 500}, headers=h
        )
    ).json()
    resp = await client.patch(
        f"/api/v1/projects/{created['id']}/items/{item['id']}",
        json={"amount_minor": 700},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["amount_minor"] == 700
    assert body["name"] == "Tiles"  # untouched field preserved
    got = (await client.get(f"/api/v1/projects/{created['id']}", headers=h)).json()
    assert got["planned_minor"] == 700


async def test_update_item_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    created = await _project(client, h)
    resp = await client.patch(
        f"/api/v1/projects/{created['id']}/items/{uuid.uuid4()}",
        json={"amount_minor": 700},
        headers=h,
    )
    assert resp.status_code == 404


async def test_add_item_no_longer_emits_funded_or_target_activity(client, initialized_instance, db):
    # Funding activity moved off the planned parts list: adding items (planned
    # amounts) never emits a funded/target-reached activity — only linked
    # transactions (actual) drive the target-reached activity now.
    h = await _auth(client)
    created = await _project(client, h, target_amount_minor=1000)
    for amount in (400, 700, 1):  # would have crossed 1000 under the old rule
        await client.post(
            f"/api/v1/projects/{created['id']}/items",
            json={"name": "Part", "amount_minor": amount},
            headers=h,
        )
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.project.funded" not in templates
    assert "activity.project.target_reached" not in templates
    # but the audit trail still records each part creation
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert actions.count("project_item.created") == 3


async def test_actual_minor_sums_linked_transactions_by_magnitude(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h, target_amount_minor=None)
    # A spending expense (negative) and a saving contribution (positive) both
    # count toward actual by magnitude.
    await _tx(client, h, acc["id"], amount_minor=-7000, project_id=project["id"])
    await _tx(client, h, acc["id"], amount_minor=3000, project_id=project["id"])
    got = (await client.get(f"/api/v1/projects/{project['id']}", headers=h)).json()
    assert got["actual_minor"] == 10000
    assert got["planned_minor"] == 0


async def test_actual_minor_excludes_other_projects(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    p1 = await _project(client, h, name="P1", target_amount_minor=None)
    p2 = await _project(client, h, name="P2", target_amount_minor=None)
    await _tx(client, h, acc["id"], amount_minor=-7000, project_id=p1["id"])
    await _tx(client, h, acc["id"], amount_minor=-2000, project_id=p2["id"])
    await _tx(client, h, acc["id"], amount_minor=-9999)  # no project at all
    got = (await client.get(f"/api/v1/projects/{p1['id']}", headers=h)).json()
    assert got["actual_minor"] == 7000


async def test_actual_minor_excludes_soft_deleted_transactions(client, initialized_instance):
    # A soft-deleted transaction no longer affects the account balance, so it
    # must not count toward a project's actual spend/savings either.
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h, target_amount_minor=None)
    tx = await _tx(client, h, acc["id"], amount_minor=-5000, project_id=project["id"])
    assert (await client.get(f"/api/v1/projects/{project['id']}", headers=h)).json()["actual_minor"] == 5000
    await client.delete(f"/api/v1/transactions/{tx['id']}", headers=h)
    assert (await client.get(f"/api/v1/projects/{project['id']}", headers=h)).json()["actual_minor"] == 0


async def _item(client, h, project_id, **overrides):
    body = {"name": "Rig chassis", "amount_minor": 6500}
    body.update(overrides)
    return (
        await client.post(f"/api/v1/projects/{project_id}/items", json=body, headers=h)
    ).json()


async def test_attach_transaction_sets_both_links_and_part_actual(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h, target_amount_minor=None)
    item = await _item(client, h, project["id"])
    tx = await _tx(client, h, acc["id"], amount_minor=-6500)  # not yet linked to any project
    resp = await client.post(
        f"/api/v1/projects/{project['id']}/items/{item['id']}/attach",
        json={"transaction_id": tx["id"]},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["transaction_id"] == tx["id"]
    assert body["actual_minor"] == 6500  # the part's actual = tx magnitude
    # the transaction now carries the project_id (Task 1 invariant upheld)
    got_tx = (await client.get(f"/api/v1/transactions/{tx['id']}", headers=h)).json()
    assert got_tx["project_id"] == project["id"]
    # and the project's actual now reflects the linked tx
    got_proj = (await client.get(f"/api/v1/projects/{project['id']}", headers=h)).json()
    assert got_proj["actual_minor"] == 6500


async def test_attach_already_attached_transaction_conflicts(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h, target_amount_minor=None)
    item1 = await _item(client, h, project["id"], name="Part 1")
    item2 = await _item(client, h, project["id"], name="Part 2")
    tx = await _tx(client, h, acc["id"], amount_minor=-6500)
    assert (
        await client.post(
            f"/api/v1/projects/{project['id']}/items/{item1['id']}/attach",
            json={"transaction_id": tx["id"]},
            headers=h,
        )
    ).status_code == 200
    # a second part cannot claim the same transaction
    resp = await client.post(
        f"/api/v1/projects/{project['id']}/items/{item2['id']}/attach",
        json={"transaction_id": tx["id"]},
        headers=h,
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "TRANSACTION_ALREADY_ATTACHED"


async def test_attach_foreign_transaction_is_404(client, initialized_instance):
    h = await _auth(client)
    project = await _project(client, h, target_amount_minor=None)
    item = await _item(client, h, project["id"])
    resp = await client.post(
        f"/api/v1/projects/{project['id']}/items/{item['id']}/attach",
        json={"transaction_id": str(uuid.uuid4())},
        headers=h,
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "TRANSACTION_NOT_FOUND"


async def test_detach_clears_part_link_but_keeps_tx_project(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h, target_amount_minor=None)
    item = await _item(client, h, project["id"])
    tx = await _tx(client, h, acc["id"], amount_minor=-6500)
    await client.post(
        f"/api/v1/projects/{project['id']}/items/{item['id']}/attach",
        json={"transaction_id": tx["id"]},
        headers=h,
    )
    resp = await client.post(
        f"/api/v1/projects/{project['id']}/items/{item['id']}/detach", headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["transaction_id"] is None  # part link cleared
    assert body["actual_minor"] is None
    # detach un-marks the part but leaves the transaction linked to the project
    got_tx = (await client.get(f"/api/v1/transactions/{tx['id']}", headers=h)).json()
    assert got_tx["project_id"] == project["id"]
    # so the project-level actual still counts the (still-linked) transaction
    got_proj = (await client.get(f"/api/v1/projects/{project['id']}", headers=h)).json()
    assert got_proj["actual_minor"] == 6500


async def test_deleting_attached_transaction_unbuys_the_part(client, initialized_instance, db):
    # The DB SET NULL from Task 1: a hard DELETE of the attached transaction
    # clears the item's transaction_id (un-buys the part) rather than destroying
    # the item. (The HTTP API only soft-deletes; this exercises the FK cascade.)
    from pecunia.models import ProjectItem, Transaction

    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h, target_amount_minor=None)
    item = await _item(client, h, project["id"])
    tx = await _tx(client, h, acc["id"], amount_minor=-6500)
    await client.post(
        f"/api/v1/projects/{project['id']}/items/{item['id']}/attach",
        json={"transaction_id": tx["id"]},
        headers=h,
    )
    tx_obj = await db.get(Transaction, uuid.UUID(tx["id"]))
    await db.delete(tx_obj)
    await db.commit()
    item_obj = await db.get(ProjectItem, uuid.UUID(item["id"]))
    assert item_obj is not None  # item survives
    assert item_obj.transaction_id is None  # un-bought via ON DELETE SET NULL


async def test_target_reached_activity_fires_on_attach_crossing_target(
    client, initialized_instance, db
):
    h = await _auth(client)
    acc = await _account(client, h)
    project = await _project(client, h, target_amount_minor=6500)
    item = await _item(client, h, project["id"])
    tx = await _tx(client, h, acc["id"], amount_minor=-6500)
    # before attaching, no target-reached activity exists
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.project.target_reached" not in templates
    # attaching a tx whose magnitude meets the target crosses it
    await client.post(
        f"/api/v1/projects/{project['id']}/items/{item['id']}/attach",
        json={"transaction_id": tx["id"]},
        headers=h,
    )
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert templates.count("activity.project.target_reached") == 1
    # attach also records a project_item.updated audit action
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "project_item.updated" in actions


async def test_cross_workspace_project_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    created = await _project(client, h)

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

    assert (await client.get(f"/api/v1/projects/{created['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/projects/{created['id']}", json={"name": "Hijacked"}, headers=other_h)
    ).status_code == 404
    assert (await client.delete(f"/api/v1/projects/{created['id']}", headers=other_h)).status_code == 404
    assert (
        await client.post(
            f"/api/v1/projects/{created['id']}/items", json={"name": "X", "amount_minor": 1}, headers=other_h
        )
    ).status_code == 404
    assert (
        await client.get(f"/api/v1/projects/{created['id']}/items", headers=other_h)
    ).status_code == 404
    lst = (await client.get("/api/v1/projects", headers=other_h)).json()
    assert all(p["id"] != created["id"] for p in lst["items"])


async def test_project_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client)
    await _project(client, h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "project.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.project.created" in templates


async def test_project_updated_and_deleted_are_audited(client, initialized_instance, db):
    h = await _auth(client)
    created = await _project(client, h)
    await client.patch(f"/api/v1/projects/{created['id']}", json={"name": "Renamed"}, headers=h)
    await client.delete(f"/api/v1/projects/{created['id']}", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "project.updated" in actions
    assert "project.deleted" in actions


async def test_project_item_created_and_updated_are_audited(client, initialized_instance, db):
    h = await _auth(client)
    created = await _project(client, h)
    item = (
        await client.post(
            f"/api/v1/projects/{created['id']}/items", json={"name": "Tiles", "amount_minor": 500}, headers=h
        )
    ).json()
    await client.patch(
        f"/api/v1/projects/{created['id']}/items/{item['id']}", json={"amount_minor": 600}, headers=h
    )
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "project_item.created" in actions
    assert "project_item.updated" in actions
