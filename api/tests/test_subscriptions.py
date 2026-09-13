import uuid
from datetime import date

import pytest
import sqlalchemy as sa

from pecunia.models import ActivityEntry, AuditEvent, Transaction
from pecunia.services.subscriptions import (
    LogoInvalidError,
    NonPositiveAmountError,
    SubscriptionService,
    annual_minor,
    monthly_minor,
)

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {
    "name": "Netflix",
    "amount_minor": 1500,
    "currency": "USD",
    "billing_frequency": "monthly",
    "next_renewal": "2026-10-01",
}
# A 1x1 transparent PNG data-URI — well under the 64KB cap, matches the prefix.
SMALL_LOGO = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAA"
    "C0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _sub(client, h, **overrides):
    body = dict(NEW)
    body.update(overrides)
    return (await client.post("/api/v1/subscriptions", json=body, headers=h)).json()


async def _contact(client, h, **overrides):
    body = {"name": "Green Valley Market"}
    body.update(overrides)
    return (await client.post("/api/v1/contacts", json=body, headers=h)).json()


# --------------------------------------------------------------------------- #
# Pure cost normalization (module-level helpers, integer minor units, §4)
# --------------------------------------------------------------------------- #


def test_annual_minor_per_frequency():
    assert annual_minor(12000, "yearly") == 12000  # $120.00/yr
    assert annual_minor(1000, "monthly") == 12000  # $10.00/mo
    assert annual_minor(1000, "weekly") == 52000  # $10.00/wk
    assert annual_minor(3000, "quarterly") == 12000  # $30.00/qtr


def test_monthly_minor_per_frequency():
    # annual / 12, banker's-rounded to the nearest minor unit.
    assert monthly_minor(12000, "yearly") == 1000
    assert monthly_minor(1000, "monthly") == 1000
    assert monthly_minor(1000, "weekly") == 4333  # round(52000 / 12)
    assert monthly_minor(3000, "quarterly") == 1000


# --------------------------------------------------------------------------- #
# CRUD (API)
# --------------------------------------------------------------------------- #


async def test_create_subscription(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post("/api/v1/subscriptions", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Netflix"
    assert body["amount_minor"] == 1500
    assert body["currency"] == "USD"
    assert body["billing_frequency"] == "monthly"
    assert body["next_renewal"] == "2026-10-01"
    assert body["status"] == "active"  # server default
    assert body["logo"] is None
    assert body["is_demo"] is False
    # computed cost rollup on the out shape
    assert body["monthly_minor"] == 1500
    assert body["annual_minor"] == 18000
    assert uuid.UUID(body["id"])


async def test_create_subscription_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/subscriptions", json=NEW)
    assert resp.status_code == 401


async def test_list_orders_soonest_renewal_first(client, initialized_instance):
    h = await _auth(client)
    await _sub(client, h, name="Later", next_renewal="2026-12-01")
    await _sub(client, h, name="Sooner", next_renewal="2026-10-01")
    await _sub(client, h, name="Middle", next_renewal="2026-11-01")
    lst = (await client.get("/api/v1/subscriptions", headers=h)).json()
    assert "next_cursor" in lst
    assert [s["next_renewal"] for s in lst["items"]] == [
        "2026-10-01",
        "2026-11-01",
        "2026-12-01",
    ]


async def test_list_keyset_paginates(client, initialized_instance):
    h = await _auth(client)
    for i in range(3):
        await _sub(client, h, name=f"S{i}", next_renewal=f"2026-1{i}-01")
    first = (await client.get("/api/v1/subscriptions?limit=2", headers=h)).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"] is not None
    second = (
        await client.get(
            f"/api/v1/subscriptions?limit=2&cursor={first['next_cursor']}", headers=h
        )
    ).json()
    assert len(second["items"]) == 1
    ids = {s["id"] for s in first["items"]} | {s["id"] for s in second["items"]}
    assert len(ids) == 3  # no overlap, no skips


async def test_list_filters_by_contact_id(client, initialized_instance):
    h = await _auth(client)
    acme = await _contact(client, h, name="Acme")
    other = await _contact(client, h, name="Other")
    matching = await _sub(client, h, name="Acme sub", contact_id=acme["id"])
    await _sub(client, h, name="Other sub", contact_id=other["id"])
    await _sub(client, h, name="No contact")

    lst = (await client.get(f"/api/v1/subscriptions?contact_id={acme['id']}", headers=h)).json()

    assert [s["id"] for s in lst["items"]] == [matching["id"]]


async def test_get_and_missing_subscription(client, initialized_instance):
    h = await _auth(client)
    created = await _sub(client, h)
    got = await client.get(f"/api/v1/subscriptions/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]
    missing = await client.get(f"/api/v1/subscriptions/{uuid.uuid4()}", headers=h)
    assert missing.status_code == 404
    assert missing.json()["detail"] == "SUBSCRIPTION_NOT_FOUND"


async def test_update_subscription(client, initialized_instance):
    h = await _auth(client)
    created = await _sub(client, h)
    resp = await client.patch(
        f"/api/v1/subscriptions/{created['id']}",
        json={"name": "Netflix Premium", "amount_minor": 2000},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Netflix Premium"
    assert body["amount_minor"] == 2000
    assert body["monthly_minor"] == 2000  # recomputed
    assert body["billing_frequency"] == "monthly"  # untouched preserved


async def test_delete_subscription_is_hard_delete(client, initialized_instance):
    h = await _auth(client)
    created = await _sub(client, h)
    resp = await client.delete(f"/api/v1/subscriptions/{created['id']}", headers=h)
    assert resp.status_code == 204
    got = await client.get(f"/api/v1/subscriptions/{created['id']}", headers=h)
    assert got.status_code == 404


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #


async def test_nonpositive_amount_rejected(client, initialized_instance):
    h = await _auth(client)
    for bad in (0, -100):
        resp = await client.post(
            "/api/v1/subscriptions", json=NEW | {"amount_minor": bad}, headers=h
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "SUBSCRIPTION_NONPOSITIVE"


async def test_invalid_logo_rejected(client, initialized_instance):
    h = await _auth(client)
    # wrong media type (gif not allowed)
    bad_prefix = await client.post(
        "/api/v1/subscriptions",
        json=NEW | {"logo": "data:image/gif;base64,AAAA"},
        headers=h,
    )
    assert bad_prefix.status_code == 422
    assert bad_prefix.json()["detail"] == "LOGO_INVALID"
    # oversized (> 64KB)
    oversized = await client.post(
        "/api/v1/subscriptions",
        json=NEW | {"logo": "data:image/png;base64," + "A" * (64 * 1024 + 1)},
        headers=h,
    )
    assert oversized.status_code == 422
    assert oversized.json()["detail"] == "LOGO_INVALID"


async def test_valid_logo_round_trips(client, initialized_instance):
    h = await _auth(client)
    created = await _sub(client, h, logo=SMALL_LOGO)
    assert created["logo"] == SMALL_LOGO
    got = (await client.get(f"/api/v1/subscriptions/{created['id']}", headers=h)).json()
    assert got["logo"] == SMALL_LOGO


async def test_foreign_links_rejected(client, initialized_instance):
    h = await _auth(client)
    for field, detail in (
        ("contact_id", "CONTACT_NOT_FOUND"),
        ("account_id", "ACCOUNT_NOT_FOUND"),
        ("category_id", "CATEGORY_NOT_FOUND"),
    ):
        resp = await client.post(
            "/api/v1/subscriptions", json=NEW | {field: str(uuid.uuid4())}, headers=h
        )
        assert resp.status_code == 404, field
        assert resp.json()["detail"] == detail


# --------------------------------------------------------------------------- #
# Renew (tracker — advances the date, posts NOTHING)
# --------------------------------------------------------------------------- #


async def test_renew_advances_and_creates_no_transaction(client, initialized_instance, db):
    h = await _auth(client)
    created = await _sub(client, h, billing_frequency="monthly", next_renewal="2026-10-01")
    before = await db.scalar(sa.select(sa.func.count()).select_from(Transaction))
    resp = await client.post(f"/api/v1/subscriptions/{created['id']}/renew", headers=h)
    assert resp.status_code == 200
    assert resp.json()["next_renewal"] == "2026-11-01"  # advanced one cycle
    after = await db.scalar(sa.select(sa.func.count()).select_from(Transaction))
    assert after == before  # a tracker: no transaction is ever posted


async def test_renew_service_creates_no_transaction(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    svc = SubscriptionService(db)
    sub = await svc.create(
        ws_id,
        name="Gym",
        amount_minor=3000,
        currency="USD",
        billing_frequency="quarterly",
        next_renewal=date(2026, 10, 1),
    )
    before = await db.scalar(sa.select(sa.func.count()).select_from(Transaction))
    await svc.renew(sub)
    assert sub.next_renewal == date(2027, 1, 1)  # +3 months
    after = await db.scalar(sa.select(sa.func.count()).select_from(Transaction))
    assert after == before


# --------------------------------------------------------------------------- #
# Totals + status (service-level; per currency, never cross-currency)
# --------------------------------------------------------------------------- #


async def test_totals_sum_active_per_currency(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    svc = SubscriptionService(db)
    await svc.create(ws_id, name="A", amount_minor=1000, currency="USD",
                     billing_frequency="monthly", next_renewal=date(2026, 10, 1))
    await svc.create(ws_id, name="B", amount_minor=12000, currency="USD",
                     billing_frequency="yearly", next_renewal=date(2026, 10, 1))
    await svc.create(ws_id, name="C", amount_minor=500, currency="EUR",
                     billing_frequency="monthly", next_renewal=date(2026, 10, 1))
    canceled = await svc.create(ws_id, name="D", amount_minor=9999, currency="USD",
                                billing_frequency="monthly", next_renewal=date(2026, 10, 1))
    await svc.set_status(canceled, "canceled")

    totals = await svc.totals(ws_id, status="active")
    assert totals["USD"] == {"monthly_minor": 2000, "annual_minor": 24000, "count": 2}
    assert totals["EUR"] == {"monthly_minor": 500, "annual_minor": 6000, "count": 1}
    # EUR never folds into USD — buckets stay their own currency.
    assert set(totals) == {"USD", "EUR"}


async def test_set_status_toggles_and_drops_from_totals(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    svc = SubscriptionService(db)
    sub = await svc.create(ws_id, name="A", amount_minor=1000, currency="USD",
                           billing_frequency="monthly", next_renewal=date(2026, 10, 1))
    assert (await svc.totals(ws_id))["USD"]["count"] == 1

    await svc.set_status(sub, "canceled")
    assert sub.status == "canceled"
    assert "USD" not in await svc.totals(ws_id, status="active")
    assert (await svc.totals(ws_id, status="canceled"))["USD"]["count"] == 1

    await svc.set_status(sub, "active")
    assert sub.status == "active"
    assert (await svc.totals(ws_id))["USD"]["count"] == 1


async def test_totals_endpoint(client, initialized_instance):
    h = await _auth(client)
    await _sub(client, h, amount_minor=1000, currency="USD", billing_frequency="monthly")
    await _sub(client, h, amount_minor=500, currency="EUR", billing_frequency="monthly")
    totals = (await client.get("/api/v1/subscriptions/totals", headers=h)).json()
    assert totals["USD"]["monthly_minor"] == 1000
    assert totals["EUR"]["monthly_minor"] == 500


async def test_service_nonpositive_and_logo_raise(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    svc = SubscriptionService(db)
    with pytest.raises(NonPositiveAmountError):
        await svc.create(ws_id, name="X", amount_minor=0, currency="USD",
                         billing_frequency="monthly", next_renewal=date(2026, 10, 1))
    with pytest.raises(LogoInvalidError):
        await svc.create(ws_id, name="X", amount_minor=100, currency="USD",
                         billing_frequency="monthly", next_renewal=date(2026, 10, 1),
                         logo="notadatauri")


# --------------------------------------------------------------------------- #
# Cross-workspace isolation
# --------------------------------------------------------------------------- #


async def test_cross_workspace_subscription_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    created = await _sub(client, h)

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

    assert (
        await client.get(f"/api/v1/subscriptions/{created['id']}", headers=other_h)
    ).status_code == 404
    assert (
        await client.patch(
            f"/api/v1/subscriptions/{created['id']}", json={"name": "Hijack"}, headers=other_h
        )
    ).status_code == 404
    assert (
        await client.post(f"/api/v1/subscriptions/{created['id']}/renew", headers=other_h)
    ).status_code == 404
    assert (
        await client.delete(f"/api/v1/subscriptions/{created['id']}", headers=other_h)
    ).status_code == 404
    lst = (await client.get("/api/v1/subscriptions", headers=other_h)).json()
    assert all(s["id"] != created["id"] for s in lst["items"])


# --------------------------------------------------------------------------- #
# Audit + activity
# --------------------------------------------------------------------------- #


async def test_subscription_lifecycle_is_audited(client, initialized_instance, db):
    h = await _auth(client)
    created = await _sub(client, h)
    await client.patch(
        f"/api/v1/subscriptions/{created['id']}", json={"name": "Renamed"}, headers=h
    )
    await client.post(f"/api/v1/subscriptions/{created['id']}/renew", headers=h)
    await client.delete(f"/api/v1/subscriptions/{created['id']}", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    for expected in (
        "subscription.created",
        "subscription.updated",
        "subscription.renewed",
        "subscription.deleted",
    ):
        assert expected in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.subscription.created" in templates
