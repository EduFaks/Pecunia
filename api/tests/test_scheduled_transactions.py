import uuid
from datetime import date

import sqlalchemy as sa

from pecunia import period
from pecunia.models import ActivityEntry, AuditEvent

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _account(client, h, **overrides):
    body = {"name": "Checking", "type": "checking", "currency": "BRL", "initial_balance_minor": 100000}
    body.update(overrides)
    return (await client.post("/api/v1/accounts", json=body, headers=h)).json()


async def _category(client, h, **overrides):
    from pecunia.models import PALETTE

    body = {"name": "Test Category", "kind": "expense", "color": PALETTE[0], "icon": None}
    body.update(overrides)
    return (await client.post("/api/v1/categories", json=body, headers=h)).json()


async def _contact(client, h, **overrides):
    body = {"name": "Green Valley Market"}
    body.update(overrides)
    return (await client.post("/api/v1/contacts", json=body, headers=h)).json()


def _sched_body(account_id, **overrides):
    body = {
        "account_id": account_id,
        "amount_minor": -5000,
        "currency": "BRL",
        "description": "Netflix",
        "frequency": "monthly",
        "next_due": "2026-09-15",
    }
    body.update(overrides)
    return body


async def _other_workspace_headers(client, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    other_user = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    await db.commit()
    token = (
        await client.post(
            "/api/v1/auth/login",
            json={"email": "other@example.com", "password": "correct horse battery staple"},
        )
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_create_schedule_returns_201_with_fields(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["account_id"] == acc["id"]
    assert body["amount_minor"] == -5000
    assert body["currency"] == "BRL"
    assert body["description"] == "Netflix"
    assert body["frequency"] == "monthly"
    assert body["interval_count"] == 1
    assert body["next_due"] == "2026-09-15"
    assert body["end_date"] is None
    assert body["is_active"] is True
    assert uuid.UUID(body["id"])


async def test_list_sorted_soonest_first(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    later = (
        await client.post(
            "/api/v1/planned", json=_sched_body(acc["id"], next_due="2026-12-01"), headers=h
        )
    ).json()
    sooner = (
        await client.post(
            "/api/v1/planned", json=_sched_body(acc["id"], next_due="2026-09-20"), headers=h
        )
    ).json()
    lst = (await client.get("/api/v1/planned", headers=h)).json()
    assert [s["id"] for s in lst["items"]] == [sooner["id"], later["id"]]


async def test_create_foreign_account_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/planned", json=_sched_body(str(uuid.uuid4())), headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ACCOUNT_NOT_FOUND"


async def test_create_foreign_category_404(client, initialized_instance, user_factory, db):
    h = await _auth(client)
    acc = await _account(client, h)
    other_h = await _other_workspace_headers(client, user_factory, db)
    other_cat = await _category(client, other_h)
    resp = await client.post(
        "/api/v1/planned", json=_sched_body(acc["id"], category_id=other_cat["id"]), headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CATEGORY_NOT_FOUND"


async def test_create_foreign_contact_404(client, initialized_instance, user_factory, db):
    h = await _auth(client)
    acc = await _account(client, h)
    other_h = await _other_workspace_headers(client, user_factory, db)
    other_contact = await _contact(client, other_h)
    resp = await client.post(
        "/api/v1/planned", json=_sched_body(acc["id"], contact_id=other_contact["id"]), headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "CONTACT_NOT_FOUND"


async def test_create_zero_amount_422(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post(
        "/api/v1/planned", json=_sched_body(acc["id"], amount_minor=0), headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "SCHEDULE_ZERO_AMOUNT"


async def test_post_creates_transaction_and_advances(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    cat = await _category(client, h)
    contact = await _contact(client, h)
    sched = (
        await client.post(
            "/api/v1/planned",
            json=_sched_body(
                acc["id"], amount_minor=-5000, category_id=cat["id"], contact_id=contact["id"]
            ),
            headers=h,
        )
    ).json()

    resp = await client.post(f"/api/v1/planned/{sched['id']}/post", headers=h)
    assert resp.status_code == 201
    body = resp.json()
    tx = body["transaction"]
    updated = body["schedule"]

    # the created transaction carries the template fields + occurred_on == pre-advance next_due
    assert tx["account_id"] == acc["id"]
    assert tx["amount_minor"] == -5000
    assert tx["currency"] == "BRL"
    assert tx["description"] == "Netflix"
    assert tx["category_id"] == cat["id"]
    assert tx["contact_id"] == contact["id"]
    assert tx["occurred_on"] == "2026-09-15"

    # next_due advanced by exactly one period (via the pure helper)
    expected = period.advance(date(2026, 9, 15), "monthly", 1)
    assert updated["next_due"] == expected.isoformat()
    assert updated["is_active"] is True

    # exactly one transaction exists on the account, and the balance moved by the amount
    txs = (await client.get(f"/api/v1/transactions?account_id={acc['id']}", headers=h)).json()
    assert len(txs["items"]) == 1
    assert txs["items"][0]["id"] == tx["id"]
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["balance_minor"] == 100000 - 5000


async def test_post_past_end_date_deactivates(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    sched = (
        await client.post(
            "/api/v1/planned",
            json=_sched_body(acc["id"], next_due="2026-09-15", end_date="2026-09-20"),
            headers=h,
        )
    ).json()
    resp = await client.post(f"/api/v1/planned/{sched['id']}/post", headers=h)
    assert resp.status_code == 201
    updated = resp.json()["schedule"]
    # advanced next_due (2026-10-15) is past end_date (2026-09-20) → deactivated
    assert updated["is_active"] is False


async def test_skip_advances_without_creating_transaction(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    sched = (
        await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)
    ).json()

    resp = await client.post(f"/api/v1/planned/{sched['id']}/skip", headers=h)
    assert resp.status_code == 200
    updated = resp.json()
    expected = period.advance(date(2026, 9, 15), "monthly", 1)
    assert updated["next_due"] == expected.isoformat()

    # NO transaction was created
    txs = (await client.get(f"/api/v1/transactions?account_id={acc['id']}", headers=h)).json()
    assert txs["items"] == []
    got = (await client.get(f"/api/v1/accounts/{acc['id']}", headers=h)).json()
    assert got["balance_minor"] == 100000


async def test_pause_hides_from_active_filter(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    sched = (
        await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)
    ).json()
    # pause via PATCH is_active=false
    patched = await client.patch(
        f"/api/v1/planned/{sched['id']}", json={"is_active": False}, headers=h
    )
    assert patched.status_code == 200
    assert patched.json()["is_active"] is False

    active = (await client.get("/api/v1/planned?is_active=true", headers=h)).json()
    assert all(s["id"] != sched["id"] for s in active["items"])
    inactive = (await client.get("/api/v1/planned?is_active=false", headers=h)).json()
    assert any(s["id"] == sched["id"] for s in inactive["items"])


async def test_update_and_get_and_delete(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    sched = (
        await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)
    ).json()

    patched = await client.patch(
        f"/api/v1/planned/{sched['id']}", json={"description": "Spotify", "amount_minor": -3000}, headers=h
    )
    assert patched.status_code == 200
    assert patched.json()["description"] == "Spotify"
    assert patched.json()["amount_minor"] == -3000

    got = (await client.get(f"/api/v1/planned/{sched['id']}", headers=h)).json()
    assert got["description"] == "Spotify"

    delete = await client.delete(f"/api/v1/planned/{sched['id']}", headers=h)
    assert delete.status_code == 204
    assert (await client.get(f"/api/v1/planned/{sched['id']}", headers=h)).status_code == 404


async def test_get_missing_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/planned/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "SCHEDULED_TRANSACTION_NOT_FOUND"


async def test_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/planned", json=_sched_body(str(uuid.uuid4())))
    assert resp.status_code == 401


async def test_cross_workspace_is_404(client, initialized_instance, user_factory, db):
    h = await _auth(client)
    acc = await _account(client, h)
    sched = (
        await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)
    ).json()
    other_h = await _other_workspace_headers(client, user_factory, db)

    assert (await client.get(f"/api/v1/planned/{sched['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/planned/{sched['id']}", json={"description": "x"}, headers=other_h)
    ).status_code == 404
    assert (await client.post(f"/api/v1/planned/{sched['id']}/post", headers=other_h)).status_code == 404
    assert (await client.post(f"/api/v1/planned/{sched['id']}/skip", headers=other_h)).status_code == 404
    assert (await client.delete(f"/api/v1/planned/{sched['id']}", headers=other_h)).status_code == 404
    lst = (await client.get("/api/v1/planned", headers=other_h)).json()
    assert all(s["id"] != sched["id"] for s in lst["items"])


async def test_schedule_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client)
    acc = await _account(client, h)
    await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "scheduled_transaction.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.scheduled_transaction.created" in templates


async def test_post_and_skip_are_audited(client, initialized_instance, db):
    h = await _auth(client)
    acc = await _account(client, h)
    s1 = (await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)).json()
    s2 = (await client.post("/api/v1/planned", json=_sched_body(acc["id"]), headers=h)).json()
    await client.post(f"/api/v1/planned/{s1['id']}/post", headers=h)
    await client.post(f"/api/v1/planned/{s2['id']}/skip", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "scheduled_transaction.posted" in actions
    assert "scheduled_transaction.skipped" in actions
    # posting also emits the normal transaction.created event
    assert "transaction.created" in actions
