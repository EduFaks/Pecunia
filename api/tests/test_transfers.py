import uuid

import sqlalchemy as sa

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


def _transfer_body(from_id, to_id, **overrides):
    body = {
        "from_account_id": from_id,
        "to_account_id": to_id,
        "amount_minor": 30000,
        "currency": "BRL",
        "description": "Move to savings",
        "occurred_on": "2026-09-12",
    }
    body.update(overrides)
    return body


async def _balance(client, h, account_id):
    return (await client.get(f"/api/v1/accounts/{account_id}", headers=h)).json()["balance_minor"]


async def _legs_of(client, h, account_id):
    """Transaction legs (transfer_id set) visible on an account."""
    lst = (await client.get(f"/api/v1/transactions?account_id={account_id}", headers=h)).json()
    return [t for t in lst["items"] if t["transfer_id"] is not None]


# --- create -----------------------------------------------------------------


async def test_create_transfer_creates_two_legs_and_moves_balances(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="Checking")
    dst = await _account(client, h, name="Savings")
    resp = await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["from_account_id"] == src["id"]
    assert body["to_account_id"] == dst["id"]
    assert body["amount_minor"] == 30000
    assert body["currency"] == "BRL"
    assert body["description"] == "Move to savings"
    assert body["is_demo"] is False
    assert uuid.UUID(body["id"])

    # exactly two legs, correct signs / accounts / transfer_id
    src_legs = await _legs_of(client, h, src["id"])
    dst_legs = await _legs_of(client, h, dst["id"])
    assert len(src_legs) == 1 and len(dst_legs) == 1
    from_leg, to_leg = src_legs[0], dst_legs[0]
    assert from_leg["amount_minor"] == -30000
    assert to_leg["amount_minor"] == 30000
    assert from_leg["account_id"] == src["id"]
    assert to_leg["account_id"] == dst["id"]
    assert from_leg["transfer_id"] == body["id"]
    assert to_leg["transfer_id"] == body["id"]

    # balances move by ∓amount
    assert await _balance(client, h, src["id"]) == 100000 - 30000
    assert await _balance(client, h, dst["id"]) == 100000 + 30000


async def test_create_transfer_same_account_422(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post("/api/v1/transfers", json=_transfer_body(acc["id"], acc["id"]), headers=h)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "TRANSFER_SAME_ACCOUNT"


async def test_create_transfer_cross_currency_422(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="BRL acct", currency="BRL")
    dst = await _account(client, h, name="USD acct", currency="USD")
    resp = await client.post(
        "/api/v1/transfers", json=_transfer_body(src["id"], dst["id"], currency="BRL"), headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "TRANSFER_CURRENCY_MISMATCH"


async def test_create_transfer_nonpositive_422(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    resp = await client.post(
        "/api/v1/transfers", json=_transfer_body(src["id"], dst["id"], amount_minor=0), headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "TRANSFER_NONPOSITIVE"


async def test_create_transfer_foreign_account_404(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h)
    resp = await client.post(
        "/api/v1/transfers", json=_transfer_body(src["id"], str(uuid.uuid4())), headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ACCOUNT_NOT_FOUND"


async def test_create_transfer_requires_auth(client, initialized_instance):
    resp = await client.post(
        "/api/v1/transfers", json=_transfer_body(str(uuid.uuid4()), str(uuid.uuid4()))
    )
    assert resp.status_code == 401


# --- list / get -------------------------------------------------------------


async def test_list_transfers_keyset(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    t1 = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"], amount_minor=10000), headers=h)).json()
    t2 = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"], amount_minor=20000), headers=h)).json()

    seen = []
    cursor = None
    for _ in range(10):
        params = {"limit": 1}
        if cursor is not None:
            params["cursor"] = cursor
        page = (await client.get("/api/v1/transfers", params=params, headers=h)).json()
        seen.extend(t["id"] for t in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    # newest-first
    assert seen == [t2["id"], t1["id"]]


async def test_get_transfer_missing_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/transfers/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "TRANSFER_NOT_FOUND"


async def test_get_transfer_other_workspace_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    tr = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)).json()

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

    assert (await client.get(f"/api/v1/transfers/{tr['id']}", headers=other_h)).status_code == 404
    assert (await client.patch(f"/api/v1/transfers/{tr['id']}", json={"amount_minor": 1}, headers=other_h)).status_code == 404
    assert (await client.delete(f"/api/v1/transfers/{tr['id']}", headers=other_h)).status_code == 404


# --- update (re-sync both legs) --------------------------------------------


async def test_update_transfer_amount_resyncs_both_legs(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    tr = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"], amount_minor=30000), headers=h)).json()
    resp = await client.patch(f"/api/v1/transfers/{tr['id']}", json={"amount_minor": 45000}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["amount_minor"] == 45000
    # both legs follow the new amount
    assert (await _legs_of(client, h, src["id"]))[0]["amount_minor"] == -45000
    assert (await _legs_of(client, h, dst["id"]))[0]["amount_minor"] == 45000
    assert await _balance(client, h, src["id"]) == 100000 - 45000
    assert await _balance(client, h, dst["id"]) == 100000 + 45000


async def test_update_transfer_account_change_repoints_and_resigns(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    dst2 = await _account(client, h, name="C")
    tr = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"], amount_minor=30000), headers=h)).json()
    # re-point the destination leg from dst to dst2
    resp = await client.patch(f"/api/v1/transfers/{tr['id']}", json={"to_account_id": dst2["id"]}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["to_account_id"] == dst2["id"]
    # old destination has no leg now; new destination carries the +amount leg
    assert await _legs_of(client, h, dst["id"]) == []
    dst2_legs = await _legs_of(client, h, dst2["id"])
    assert len(dst2_legs) == 1
    assert dst2_legs[0]["amount_minor"] == 30000
    assert dst2_legs[0]["account_id"] == dst2["id"]
    # balances: source unchanged, old dst reverted, new dst credited
    assert await _balance(client, h, src["id"]) == 100000 - 30000
    assert await _balance(client, h, dst["id"]) == 100000
    assert await _balance(client, h, dst2["id"]) == 100000 + 30000


async def test_update_transfer_same_account_422(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    tr = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)).json()
    resp = await client.patch(f"/api/v1/transfers/{tr['id']}", json={"to_account_id": src["id"]}, headers=h)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "TRANSFER_SAME_ACCOUNT"


async def test_update_transfer_cross_currency_422(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A", currency="BRL")
    dst = await _account(client, h, name="B", currency="BRL")
    usd = await _account(client, h, name="USD", currency="USD")
    tr = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)).json()
    resp = await client.patch(f"/api/v1/transfers/{tr['id']}", json={"to_account_id": usd["id"]}, headers=h)
    assert resp.status_code == 422
    assert resp.json()["detail"] == "TRANSFER_CURRENCY_MISMATCH"


# --- delete -----------------------------------------------------------------


async def test_delete_transfer_removes_both_legs_and_reverts_balances(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    tr = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"], amount_minor=30000), headers=h)).json()
    assert await _balance(client, h, src["id"]) == 100000 - 30000
    resp = await client.delete(f"/api/v1/transfers/{tr['id']}", headers=h)
    assert resp.status_code == 204
    # transfer gone
    assert (await client.get(f"/api/v1/transfers/{tr['id']}", headers=h)).status_code == 404
    # both legs gone (CASCADE), balances revert
    assert await _legs_of(client, h, src["id"]) == []
    assert await _legs_of(client, h, dst["id"]) == []
    assert await _balance(client, h, src["id"]) == 100000
    assert await _balance(client, h, dst["id"]) == 100000


# --- events -----------------------------------------------------------------


async def test_transfer_created_is_audited_and_in_activity(client, initialized_instance, db):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "transfer.created" in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.transfer.created" in templates


async def test_transfer_updated_and_deleted_are_audited(client, initialized_instance, db):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    tr = (await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)).json()
    await client.patch(f"/api/v1/transfers/{tr['id']}", json={"amount_minor": 5000}, headers=h)
    await client.delete(f"/api/v1/transfers/{tr['id']}", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "transfer.updated" in actions
    assert "transfer.deleted" in actions


# --- transaction-leg guards (the invariant) ---------------------------------


async def test_transaction_leg_cannot_be_patched(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)
    leg = (await _legs_of(client, h, src["id"]))[0]
    resp = await client.patch(f"/api/v1/transactions/{leg['id']}", json={"description": "hijack"}, headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "MANAGED_BY_TRANSFER"


async def test_transaction_leg_cannot_be_deleted(client, initialized_instance):
    h = await _auth(client)
    src = await _account(client, h, name="A")
    dst = await _account(client, h, name="B")
    await client.post("/api/v1/transfers", json=_transfer_body(src["id"], dst["id"]), headers=h)
    leg = (await _legs_of(client, h, src["id"]))[0]
    resp = await client.delete(f"/api/v1/transactions/{leg['id']}", headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "MANAGED_BY_TRANSFER"


async def test_plain_transaction_create_cannot_set_transfer_id(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    body = {
        "account_id": acc["id"],
        "amount_minor": -500,
        "currency": "BRL",
        "description": "Coffee",
        "occurred_on": "2026-09-12",
        "transfer_id": str(uuid.uuid4()),  # must be ignored, never accepted
    }
    resp = await client.post("/api/v1/transactions", json=body, headers=h)
    assert resp.status_code == 201
    assert resp.json()["transfer_id"] is None


async def test_transaction_out_transfer_id_null_for_plain(client, initialized_instance):
    h = await _auth(client)
    acc = await _account(client, h)
    resp = await client.post(
        "/api/v1/transactions",
        json={
            "account_id": acc["id"],
            "amount_minor": -500,
            "currency": "BRL",
            "description": "Coffee",
            "occurred_on": "2026-09-12",
        },
        headers=h,
    )
    assert resp.status_code == 201
    assert resp.json()["transfer_id"] is None
