import uuid
from datetime import date

import sqlalchemy as sa

from pecunia.models import Account, ActivityEntry, AuditEvent, Loan, LoanPayment, Transaction
from pecunia.services.loans import LoanService

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {
    "name": "Car loan",
    "direction": "borrowed",
    "principal_minor": 2_500_000,
    "currency": "USD",
    "interest_rate_bps": 599,
    "planned_payment_minor": 45_000,
    "payment_frequency": "monthly",
    "next_due": "2026-10-01",
    "opened_on": "2025-10-01",
    "description": "Financing",
}


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _loan(client, h, **overrides):
    body = dict(NEW)
    body.update(overrides)
    return (await client.post("/api/v1/loans", json=body, headers=h)).json()


async def _pay(client, h, loan_id, *, amount_minor, paid_on, note=None, transaction_id=None):
    body = {"amount_minor": amount_minor, "paid_on": paid_on}
    if note is not None:
        body["note"] = note
    if transaction_id is not None:
        body["transaction_id"] = transaction_id
    return await client.post(f"/api/v1/loans/{loan_id}/payments", json=body, headers=h)


async def _account(client, h, *, currency="USD", name="Checking"):
    return (
        await client.post(
            "/api/v1/accounts",
            json={"name": name, "type": "checking", "currency": currency},
            headers=h,
        )
    ).json()


async def _tx(client, h, account_id, *, amount_minor=-45_000, occurred_on="2026-06-01", description="loan payment", currency="USD"):
    return (
        await client.post(
            "/api/v1/transactions",
            json={
                "account_id": account_id,
                "amount_minor": amount_minor,
                "currency": currency,
                "description": description,
                "occurred_on": occurred_on,
            },
            headers=h,
        )
    ).json()


# --------------------------------------------------------------------------- #
# Loan CRUD (API)
# --------------------------------------------------------------------------- #


async def test_create_loan(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post("/api/v1/loans", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Car loan"
    assert body["direction"] == "borrowed"
    assert body["principal_minor"] == 2_500_000
    assert body["currency"] == "USD"
    assert body["interest_rate_bps"] == 599
    assert body["planned_payment_minor"] == 45_000
    assert body["payment_frequency"] == "monthly"
    assert body["next_due"] == "2026-10-01"
    assert body["opened_on"] == "2025-10-01"
    assert body["is_demo"] is False
    # No payments yet -> nothing paid, full principal remains.
    assert body["paid_total_minor"] == 0
    assert body["remaining_minor"] == 2_500_000
    assert uuid.UUID(body["id"])


async def test_create_loan_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/loans", json=NEW)
    assert resp.status_code == 401


async def test_create_loan_minimal(client, initialized_instance):
    """Only the required fields; optional schedule/rate omitted."""
    h = await _auth(client)
    resp = await client.post(
        "/api/v1/loans",
        json={"name": "IOU", "direction": "lent", "principal_minor": 100, "currency": "USD"},
        headers=h,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["direction"] == "lent"
    assert body["interest_rate_bps"] is None
    assert body["planned_payment_minor"] is None
    assert body["payment_frequency"] is None
    assert body["remaining_minor"] == 100


async def test_invalid_direction_rejected(client, initialized_instance):
    h = await _auth(client)
    assert (
        await client.post("/api/v1/loans", json=NEW | {"direction": "sideways"}, headers=h)
    ).status_code == 422


async def test_invalid_frequency_rejected(client, initialized_instance):
    h = await _auth(client)
    assert (
        await client.post("/api/v1/loans", json=NEW | {"payment_frequency": "fortnightly"}, headers=h)
    ).status_code == 422


async def test_invalid_currency_rejected(client, initialized_instance):
    h = await _auth(client)
    assert (
        await client.post("/api/v1/loans", json=NEW | {"currency": "usd"}, headers=h)
    ).status_code == 422


async def test_list_and_get_loan(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h)
    lst = (await client.get("/api/v1/loans", headers=h)).json()
    assert any(loan["id"] == created["id"] for loan in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/loans/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_list_loan_keyset_paginates(client, initialized_instance):
    h = await _auth(client)
    for i in range(3):
        await _loan(client, h, name=f"L{i}")
    first = (await client.get("/api/v1/loans?limit=2", headers=h)).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"] is not None
    second = (
        await client.get(f"/api/v1/loans?limit=2&cursor={first['next_cursor']}", headers=h)
    ).json()
    assert len(second["items"]) == 1
    ids = {loan["id"] for loan in first["items"]} | {loan["id"] for loan in second["items"]}
    assert len(ids) == 3  # no overlap, no skips


async def test_get_missing_loan_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/loans/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "LOAN_NOT_FOUND"


async def test_update_loan(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h)
    resp = await client.patch(
        f"/api/v1/loans/{created['id']}",
        json={"name": "Auto loan", "planned_payment_minor": 50_000},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Auto loan"
    assert body["planned_payment_minor"] == 50_000
    assert body["direction"] == "borrowed"  # untouched preserved
    got = (await client.get(f"/api/v1/loans/{created['id']}", headers=h)).json()
    assert got["name"] == "Auto loan"


async def test_update_loan_clears_nullable(client, initialized_instance):
    """Explicit null clears an optional field; an absent field is preserved."""
    h = await _auth(client)
    created = await _loan(client, h)
    resp = await client.patch(
        f"/api/v1/loans/{created['id']}", json={"interest_rate_bps": None}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["interest_rate_bps"] is None
    assert resp.json()["planned_payment_minor"] == 45_000  # untouched


async def test_delete_loan_is_hard_delete(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h)
    resp = await client.delete(f"/api/v1/loans/{created['id']}", headers=h)
    assert resp.status_code == 204
    got = await client.get(f"/api/v1/loans/{created['id']}", headers=h)
    assert got.status_code == 404


async def test_delete_loan_cascades_payments(client, initialized_instance, db):
    h = await _auth(client)
    created = await _loan(client, h)
    await _pay(client, h, created["id"], amount_minor=45_000, paid_on="2026-06-01")
    await client.delete(f"/api/v1/loans/{created['id']}", headers=h)
    remaining = (
        await db.execute(
            sa.select(LoanPayment).where(LoanPayment.loan_id == uuid.UUID(created["id"]))
        )
    ).scalars().all()
    assert remaining == []


async def test_delete_missing_loan_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.delete(f"/api/v1/loans/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Payments (API)
# --------------------------------------------------------------------------- #


async def test_record_payment_then_totals(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h)
    r1 = await _pay(client, h, created["id"], amount_minor=45_000, paid_on="2026-04-01", note="April")
    assert r1.status_code == 201
    p1 = r1.json()
    assert p1["amount_minor"] == 45_000
    assert p1["paid_on"] == "2026-04-01"
    assert p1["note"] == "April"
    assert p1["loan_id"] == created["id"]
    await _pay(client, h, created["id"], amount_minor=45_000, paid_on="2026-05-01")

    got = (await client.get(f"/api/v1/loans/{created['id']}", headers=h)).json()
    assert got["paid_total_minor"] == 90_000
    assert got["remaining_minor"] == 2_500_000 - 90_000


async def test_list_payments_ordered_paid_on_desc(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h)
    await _pay(client, h, created["id"], amount_minor=100, paid_on="2026-01-01")
    await _pay(client, h, created["id"], amount_minor=200, paid_on="2026-03-01")
    await _pay(client, h, created["id"], amount_minor=300, paid_on="2026-02-01")
    lst = (await client.get(f"/api/v1/loans/{created['id']}/payments", headers=h)).json()
    assert "next_cursor" in lst
    assert [p["paid_on"] for p in lst["items"]] == ["2026-03-01", "2026-02-01", "2026-01-01"]


async def test_delete_payment(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h)
    pay = (await _pay(client, h, created["id"], amount_minor=45_000, paid_on="2026-04-01")).json()
    resp = await client.delete(
        f"/api/v1/loans/{created['id']}/payments/{pay['id']}", headers=h
    )
    assert resp.status_code == 204
    got = (await client.get(f"/api/v1/loans/{created['id']}", headers=h)).json()
    assert got["paid_total_minor"] == 0
    assert got["remaining_minor"] == 2_500_000


async def test_record_nonpositive_payment_rejected(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h)
    for bad in (0, -100):
        resp = await _pay(client, h, created["id"], amount_minor=bad, paid_on="2026-04-01")
        assert resp.status_code == 422
        assert resp.json()["detail"] == "LOAN_PAYMENT_NONPOSITIVE"


async def test_remaining_floors_at_zero_when_overpaid(client, initialized_instance):
    h = await _auth(client)
    created = await _loan(client, h, principal_minor=100)
    await _pay(client, h, created["id"], amount_minor=90, paid_on="2026-04-01")
    await _pay(client, h, created["id"], amount_minor=90, paid_on="2026-05-01")
    got = (await client.get(f"/api/v1/loans/{created['id']}", headers=h)).json()
    assert got["paid_total_minor"] == 180
    assert got["remaining_minor"] == 0  # floored, never negative


async def test_payment_on_missing_loan_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await _pay(client, h, uuid.uuid4(), amount_minor=100, paid_on="2026-04-01")
    assert resp.status_code == 404


async def test_delete_payment_on_wrong_loan_is_404(client, initialized_instance):
    """A payment reached through a different loan in the same workspace is a
    404, not a cross-loan delete."""
    h = await _auth(client)
    loan1 = await _loan(client, h, name="L1")
    loan2 = await _loan(client, h, name="L2")
    pay = (await _pay(client, h, loan1["id"], amount_minor=100, paid_on="2026-04-01")).json()
    assert (
        await client.delete(f"/api/v1/loans/{loan2['id']}/payments/{pay['id']}", headers=h)
    ).status_code == 404
    # still there under its real loan
    lst = (await client.get(f"/api/v1/loans/{loan1['id']}/payments", headers=h)).json()
    assert any(p["id"] == pay["id"] for p in lst["items"])


async def test_list_payments_on_missing_loan_returns_404(client, initialized_instance):
    h = await _auth(client)
    assert (
        await client.get(f"/api/v1/loans/{uuid.uuid4()}/payments", headers=h)
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Cross-workspace isolation (API)
# --------------------------------------------------------------------------- #


async def test_cross_workspace_loan_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    created = await _loan(client, h)
    pay = (await _pay(client, h, created["id"], amount_minor=100, paid_on="2026-04-01")).json()

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

    assert (await client.get(f"/api/v1/loans/{created['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(f"/api/v1/loans/{created['id']}", json={"name": "Hijack"}, headers=other_h)
    ).status_code == 404
    assert (
        await client.delete(f"/api/v1/loans/{created['id']}", headers=other_h)
    ).status_code == 404
    assert (
        await client.get(f"/api/v1/loans/{created['id']}/payments", headers=other_h)
    ).status_code == 404
    assert (
        await client.delete(f"/api/v1/loans/{created['id']}/payments/{pay['id']}", headers=other_h)
    ).status_code == 404
    lst = (await client.get("/api/v1/loans", headers=other_h)).json()
    assert all(loan["id"] != created["id"] for loan in lst["items"])


# --------------------------------------------------------------------------- #
# Audit + activity
# --------------------------------------------------------------------------- #


async def test_loan_lifecycle_is_audited(client, initialized_instance, db):
    h = await _auth(client)
    loan = await _loan(client, h)
    pay = (await _pay(client, h, loan["id"], amount_minor=100, paid_on="2026-04-01")).json()
    await client.patch(f"/api/v1/loans/{loan['id']}", json={"name": "Renamed"}, headers=h)
    await client.delete(f"/api/v1/loans/{loan['id']}/payments/{pay['id']}", headers=h)
    await client.delete(f"/api/v1/loans/{loan['id']}", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    for expected in (
        "loan.created",
        "loan.updated",
        "loan.deleted",
        "loan_payment.recorded",
        "loan_payment.deleted",
    ):
        assert expected in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.loan.created" in templates


# --------------------------------------------------------------------------- #
# Service-level: paid_total / remaining math (integer minor units, §4)
# --------------------------------------------------------------------------- #


async def _svc_loan(db, ws_id, *, direction="borrowed", principal=2_500_000, currency="USD", name="L"):
    loan = Loan(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, direction=direction,
        principal_minor=principal, currency=currency,
    )
    db.add(loan)
    await db.flush()
    return loan


async def _svc_pay(db, ws_id, loan, *, amount, paid_on):
    p = LoanPayment(
        id=uuid.uuid4(), workspace_id=ws_id, loan_id=loan.id,
        amount_minor=amount, paid_on=paid_on,
    )
    db.add(p)
    await db.flush()
    return p


async def test_paid_total_and_remaining_no_payments(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    loan = await _svc_loan(db, ws_id, principal=1000)
    svc = LoanService(db)
    assert await svc.paid_total_minor(loan) == 0
    assert await svc.remaining_minor(loan) == 1000
    assert type(await svc.remaining_minor(loan)) is int


async def test_remaining_floors_at_zero(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    loan = await _svc_loan(db, ws_id, principal=100)
    await _svc_pay(db, ws_id, loan, amount=90, paid_on=date(2026, 4, 1))
    await _svc_pay(db, ws_id, loan, amount=90, paid_on=date(2026, 5, 1))
    svc = LoanService(db)
    assert await svc.paid_total_minor(loan) == 180
    assert await svc.remaining_minor(loan) == 0


async def test_remaining_on_date_counts_only_payments_on_or_before(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    loan = await _svc_loan(db, ws_id, principal=1000)
    await _svc_pay(db, ws_id, loan, amount=100, paid_on=date(2026, 1, 1))
    await _svc_pay(db, ws_id, loan, amount=200, paid_on=date(2026, 6, 1))
    svc = LoanService(db)
    # before any payment
    assert await svc.paid_total_minor(loan, on_date=date(2025, 12, 31)) == 0
    assert await svc.remaining_minor(loan, on_date=date(2025, 12, 31)) == 1000
    # only the first payment counts
    assert await svc.paid_total_minor(loan, on_date=date(2026, 3, 1)) == 100
    assert await svc.remaining_minor(loan, on_date=date(2026, 3, 1)) == 900
    # on the second payment's date, both count
    assert await svc.paid_total_minor(loan, on_date=date(2026, 6, 1)) == 300
    assert await svc.remaining_minor(loan, on_date=date(2026, 6, 1)) == 700
    # no date -> all payments
    assert await svc.remaining_minor(loan) == 700


async def test_record_payment_nonpositive_raises(db, initialized_instance):
    import pytest

    from pecunia.services.loans import NonPositivePaymentError

    ws_id = initialized_instance["workspace_id"]
    loan = await _svc_loan(db, ws_id, principal=1000)
    svc = LoanService(db)
    with pytest.raises(NonPositivePaymentError):
        await svc.record_payment(loan, amount_minor=0, paid_on=date(2026, 4, 1))
    with pytest.raises(NonPositivePaymentError):
        await svc.record_payment(loan, amount_minor=-5, paid_on=date(2026, 4, 1))


async def test_totals_are_workspace_scoped(db, initialized_instance, user_factory):
    """A payment against a loan of the same id-space in another workspace never
    leaks into this loan's totals (loans/payments are workspace-scoped)."""
    from pecunia.models import Workspace, WorkspaceMembership

    ws_id = initialized_instance["workspace_id"]
    loan = await _svc_loan(db, ws_id, principal=1000)
    await _svc_pay(db, ws_id, loan, amount=100, paid_on=date(2026, 1, 1))

    other = await user_factory(email="other2@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    other_loan = await _svc_loan(db, other_ws.id, principal=1000, name="Other loan")
    await _svc_pay(db, other_ws.id, other_loan, amount=999, paid_on=date(2026, 1, 1))

    svc = LoanService(db)
    assert await svc.paid_total_minor(loan) == 100
    assert await svc.remaining_minor(loan) == 900


# --------------------------------------------------------------------------- #
# Payment ↔ transaction linking (Track J)
# --------------------------------------------------------------------------- #


async def test_record_payment_with_transaction_id(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"], amount_minor=-45_000, occurred_on="2026-06-01")
    resp = await _pay(
        client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01", transaction_id=tx["id"]
    )
    assert resp.status_code == 201
    assert resp.json()["transaction_id"] == tx["id"]
    got = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()
    assert got["remaining_minor"] == 2_500_000 - 45_000


async def test_record_payment_with_foreign_tx_is_404(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    resp = await _pay(
        client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01",
        transaction_id=str(uuid.uuid4()),
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "TRANSACTION_NOT_FOUND"


async def test_record_payment_with_already_linked_tx_is_409(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"])
    await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01", transaction_id=tx["id"])
    resp = await _pay(
        client, h, loan["id"], amount_minor=45_000, paid_on="2026-07-01", transaction_id=tx["id"]
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "TRANSACTION_ALREADY_LINKED"


async def test_update_payment_edits_fields(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    pay = (await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01")).json()
    resp = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}",
        json={"amount_minor": 50_000, "note": "adjusted", "paid_on": "2026-06-02"},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["amount_minor"] == 50_000
    assert body["note"] == "adjusted"
    assert body["paid_on"] == "2026-06-02"
    got = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()
    assert got["remaining_minor"] == 2_500_000 - 50_000


async def test_update_payment_attaches_then_detaches(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"])
    pay = (await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01")).json()
    assert pay["transaction_id"] is None
    # attach
    r = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}",
        json={"transaction_id": tx["id"]}, headers=h,
    )
    assert r.status_code == 200
    assert r.json()["transaction_id"] == tx["id"]
    # detach: an explicit null clears the link
    r = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}",
        json={"transaction_id": None}, headers=h,
    )
    assert r.status_code == 200
    assert r.json()["transaction_id"] is None


async def test_update_payment_attach_foreign_tx_is_404(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    pay = (await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01")).json()
    r = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}",
        json={"transaction_id": str(uuid.uuid4())}, headers=h,
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "TRANSACTION_NOT_FOUND"


async def test_update_payment_attach_already_linked_tx_is_409(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"])
    # first payment takes the tx
    await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01", transaction_id=tx["id"])
    # a second payment tries to attach the same tx via PATCH
    pay2 = (await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-07-01")).json()
    r = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay2['id']}",
        json={"transaction_id": tx["id"]}, headers=h,
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "TRANSACTION_ALREADY_LINKED"


async def test_update_payment_reattach_same_tx_is_idempotent(client, initialized_instance):
    """Re-attaching the same tx to the same payment is not a conflict."""
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"])
    pay = (await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01", transaction_id=tx["id"])).json()
    r = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}",
        json={"transaction_id": tx["id"]}, headers=h,
    )
    assert r.status_code == 200
    assert r.json()["transaction_id"] == tx["id"]


async def test_update_payment_on_wrong_loan_is_404(client, initialized_instance):
    h = await _auth(client)
    loan1 = await _loan(client, h, name="L1")
    loan2 = await _loan(client, h, name="L2")
    pay = (await _pay(client, h, loan1["id"], amount_minor=100, paid_on="2026-06-01")).json()
    resp = await client.patch(
        f"/api/v1/loans/{loan2['id']}/payments/{pay['id']}", json={"note": "x"}, headers=h
    )
    assert resp.status_code == 404


async def test_update_payment_is_audited(client, initialized_instance, db):
    h = await _auth(client)
    loan = await _loan(client, h)
    pay = (await _pay(client, h, loan["id"], amount_minor=100, paid_on="2026-06-01")).json()
    await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}", json={"note": "edited"}, headers=h
    )
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    assert "loan_payment.updated" in actions


async def test_apply_transaction_to_loan(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"], amount_minor=-45_000, occurred_on="2026-06-01")
    resp = await client.post(
        f"/api/v1/transactions/{tx['id']}/apply-to-loan", json={"loan_id": loan["id"]}, headers=h
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["loan_id"] == loan["id"]
    assert body["transaction_id"] == tx["id"]
    assert body["amount_minor"] == 45_000  # abs(tx.amount_minor)
    assert body["paid_on"] == "2026-06-01"  # tx.occurred_on
    got = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()
    assert got["remaining_minor"] == 2_500_000 - 45_000


async def test_apply_to_missing_loan_is_404(client, initialized_instance):
    h = await _auth(client)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"])
    resp = await client.post(
        f"/api/v1/transactions/{tx['id']}/apply-to-loan",
        json={"loan_id": str(uuid.uuid4())}, headers=h,
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "LOAN_NOT_FOUND"


async def test_apply_missing_transaction_is_404(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    resp = await client.post(
        f"/api/v1/transactions/{uuid.uuid4()}/apply-to-loan", json={"loan_id": loan["id"]}, headers=h
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "TRANSACTION_NOT_FOUND"


async def test_apply_already_linked_transaction_is_409(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"])
    first = await client.post(
        f"/api/v1/transactions/{tx['id']}/apply-to-loan", json={"loan_id": loan["id"]}, headers=h
    )
    assert first.status_code == 201
    second = await client.post(
        f"/api/v1/transactions/{tx['id']}/apply-to-loan", json={"loan_id": loan["id"]}, headers=h
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "TRANSACTION_ALREADY_LINKED"


async def test_deleting_linked_transaction_keeps_payment_null_link(client, initialized_instance, db):
    """A real (hard) transaction delete SET-NULLs the payment's link — the
    payment survives and the loan's remaining is unchanged."""
    h = await _auth(client)
    loan = await _loan(client, h)
    acct = await _account(client, h)
    tx = await _tx(client, h, acct["id"], amount_minor=-45_000, occurred_on="2026-06-01")
    pay = (await _pay(
        client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01", transaction_id=tx["id"]
    )).json()
    before = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()["remaining_minor"]

    # The API soft-deletes; the FK's ON DELETE SET NULL fires only on a real
    # row delete, so delete the tx row directly.
    await db.execute(sa.delete(Transaction).where(Transaction.id == uuid.UUID(tx["id"])))
    await db.commit()

    payments = (await client.get(f"/api/v1/loans/{loan['id']}/payments", headers=h)).json()["items"]
    survived = [p for p in payments if p["id"] == pay["id"]]
    assert len(survived) == 1
    assert survived[0]["transaction_id"] is None
    after = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()["remaining_minor"]
    assert after == before


async def test_link_transaction_is_workspace_scoped(client, initialized_instance, user_factory, db):
    """A transaction in another workspace cannot be linked or applied to this
    workspace's loan — it is invisible (404), never a cross-workspace link."""
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    loan = await _loan(client, h)

    other_user = await user_factory(email="other3@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    other_acct = Account(
        id=uuid.uuid4(), workspace_id=other_ws.id, name="C", type="checking", currency="USD"
    )
    db.add(other_acct)
    await db.flush()
    foreign_tx = Transaction(
        id=uuid.uuid4(), workspace_id=other_ws.id, account_id=other_acct.id,
        amount_minor=-100, currency="USD", description="x", occurred_on=date(2026, 6, 1),
    )
    db.add(foreign_tx)
    await db.commit()

    resp = await _pay(
        client, h, loan["id"], amount_minor=100, paid_on="2026-06-01",
        transaction_id=str(foreign_tx.id),
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "TRANSACTION_NOT_FOUND"

    resp2 = await client.post(
        f"/api/v1/transactions/{foreign_tx.id}/apply-to-loan", json={"loan_id": loan["id"]}, headers=h
    )
    assert resp2.status_code == 404
    assert resp2.json()["detail"] == "TRANSACTION_NOT_FOUND"


async def test_update_payment_unset_leaves_link_none_clears(db, initialized_instance):
    """Service-level UNSET vs None: omitting transaction_id leaves the link
    intact while editing another field; passing None clears it."""
    ws_id = initialized_instance["workspace_id"]
    account = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name="C", type="checking", currency="USD"
    )
    db.add(account)
    await db.flush()
    loan = await _svc_loan(db, ws_id, principal=1000)
    tx = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=-100, currency="USD", description="x", occurred_on=date(2026, 6, 1),
    )
    db.add(tx)
    await db.flush()
    svc = LoanService(db)
    pay = await svc.record_payment(
        loan, amount_minor=100, paid_on=date(2026, 6, 1), transaction_id=tx.id
    )
    assert pay.transaction_id == tx.id
    # UNSET (field omitted) leaves the link untouched while editing another field
    await svc.update_payment(pay, amount_minor=150)
    assert pay.transaction_id == tx.id
    assert pay.amount_minor == 150
    # None clears the link
    await svc.update_payment(pay, transaction_id=None)
    assert pay.transaction_id is None


# --------------------------------------------------------------------------- #
# Link guards: same-currency, non-transfer-leg (Track J review-fix)
# --------------------------------------------------------------------------- #


async def _transfer_leg(client, h):
    """Create a transfer between two accounts and return one of its leg
    transactions (a tx carrying transfer_id — already managed by its transfer)."""
    a1 = await _account(client, h, name="Src")
    a2 = await _account(client, h, name="Dst")
    await client.post(
        "/api/v1/transfers",
        json={
            "from_account_id": a1["id"],
            "to_account_id": a2["id"],
            "amount_minor": 45_000,
            "currency": "USD",
            "description": "move",
            "occurred_on": "2026-06-01",
        },
        headers=h,
    )
    lst = (await client.get(f"/api/v1/transactions?account_id={a1['id']}", headers=h)).json()
    return next(t for t in lst["items"] if t["transfer_id"] is not None)


async def test_record_payment_foreign_currency_tx_is_422(client, initialized_instance):
    """A funding tx in a different currency than the loan can't fund a payment —
    a foreign amount would corrupt remaining_minor (§4, never mix currencies)."""
    h = await _auth(client)
    loan = await _loan(client, h)  # USD
    eur_acct = await _account(client, h, currency="EUR", name="Euro")
    tx = await _tx(client, h, eur_acct["id"], amount_minor=-45_000, currency="EUR")
    resp = await _pay(
        client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01", transaction_id=tx["id"]
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "LOAN_PAYMENT_CURRENCY_MISMATCH"
    # rejected link → no payment recorded, remaining unchanged
    got = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()
    assert got["remaining_minor"] == 2_500_000


async def test_update_payment_attach_foreign_currency_tx_is_422(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)  # USD
    eur_acct = await _account(client, h, currency="EUR", name="Euro")
    tx = await _tx(client, h, eur_acct["id"], amount_minor=-45_000, currency="EUR")
    pay = (await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01")).json()
    r = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}",
        json={"transaction_id": tx["id"]}, headers=h,
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "LOAN_PAYMENT_CURRENCY_MISMATCH"
    # link untouched (validated before mutating)
    items = (await client.get(f"/api/v1/loans/{loan['id']}/payments", headers=h)).json()["items"]
    assert next(p for p in items if p["id"] == pay["id"])["transaction_id"] is None


async def test_apply_foreign_currency_tx_to_loan_is_422(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)  # USD
    eur_acct = await _account(client, h, currency="EUR", name="Euro")
    tx = await _tx(client, h, eur_acct["id"], amount_minor=-45_000, currency="EUR")
    resp = await client.post(
        f"/api/v1/transactions/{tx['id']}/apply-to-loan", json={"loan_id": loan["id"]}, headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "LOAN_PAYMENT_CURRENCY_MISMATCH"
    got = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()
    assert got["remaining_minor"] == 2_500_000


async def test_record_payment_transfer_leg_is_422(client, initialized_instance):
    """A transfer leg is already managed by its transfer — it can't fund a loan
    payment. Same currency as the loan, so this exercises the leg guard alone."""
    h = await _auth(client)
    loan = await _loan(client, h)
    leg = await _transfer_leg(client, h)
    resp = await _pay(
        client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01", transaction_id=leg["id"]
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "TRANSACTION_IS_TRANSFER_LEG"
    got = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()
    assert got["remaining_minor"] == 2_500_000


async def test_update_payment_attach_transfer_leg_is_422(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    leg = await _transfer_leg(client, h)
    pay = (await _pay(client, h, loan["id"], amount_minor=45_000, paid_on="2026-06-01")).json()
    r = await client.patch(
        f"/api/v1/loans/{loan['id']}/payments/{pay['id']}",
        json={"transaction_id": leg["id"]}, headers=h,
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "TRANSACTION_IS_TRANSFER_LEG"
    items = (await client.get(f"/api/v1/loans/{loan['id']}/payments", headers=h)).json()["items"]
    assert next(p for p in items if p["id"] == pay["id"])["transaction_id"] is None


async def test_apply_transfer_leg_to_loan_is_422(client, initialized_instance):
    h = await _auth(client)
    loan = await _loan(client, h)
    leg = await _transfer_leg(client, h)
    resp = await client.post(
        f"/api/v1/transactions/{leg['id']}/apply-to-loan", json={"loan_id": loan["id"]}, headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "TRANSACTION_IS_TRANSFER_LEG"
    got = (await client.get(f"/api/v1/loans/{loan['id']}", headers=h)).json()
    assert got["remaining_minor"] == 2_500_000
