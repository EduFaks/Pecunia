import uuid
from datetime import date
from decimal import Decimal

import sqlalchemy as sa

from pecunia.models import ActivityEntry, AuditEvent, Holding, HoldingPrice, Portfolio
from pecunia.services.portfolios import PortfolioService

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
NEW = {"name": "Brokerage", "currency": "USD", "description": "Long-term"}


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _portfolio(client, h, **overrides):
    body = dict(NEW)
    body.update(overrides)
    return (await client.post("/api/v1/portfolios", json=body, headers=h)).json()


async def _holding(client, h, portfolio_id, *, quantity="1", name="Fund", symbol=None):
    body = {"name": name, "quantity": quantity}
    if symbol is not None:
        body["symbol"] = symbol
    return (
        await client.post(f"/api/v1/portfolios/{portfolio_id}/holdings", json=body, headers=h)
    ).json()


async def _record_price(client, h, portfolio_id, holding_id, *, unit_price_minor, as_of, source=None):
    body = {"unit_price_minor": unit_price_minor, "as_of": as_of}
    if source is not None:
        body["source"] = source
    return await client.post(
        f"/api/v1/portfolios/{portfolio_id}/holdings/{holding_id}/prices", json=body, headers=h
    )


# --------------------------------------------------------------------------- #
# Portfolio CRUD (API)
# --------------------------------------------------------------------------- #


async def test_create_portfolio(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post("/api/v1/portfolios", json=NEW, headers=h)
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Brokerage"
    assert body["currency"] == "USD"
    assert body["description"] == "Long-term"
    assert body["is_demo"] is False
    assert body["value_minor"] == 0
    assert body["holding_count"] == 0
    assert uuid.UUID(body["id"])


async def test_create_portfolio_requires_auth(client, initialized_instance):
    resp = await client.post("/api/v1/portfolios", json=NEW)
    assert resp.status_code == 401


async def test_invalid_currency_rejected(client, initialized_instance):
    h = await _auth(client)
    assert (
        await client.post("/api/v1/portfolios", json=NEW | {"currency": "usd"}, headers=h)
    ).status_code == 422


async def test_list_and_get_portfolio(client, initialized_instance):
    h = await _auth(client)
    created = await _portfolio(client, h)
    lst = (await client.get("/api/v1/portfolios", headers=h)).json()
    assert any(p["id"] == created["id"] for p in lst["items"])
    assert "next_cursor" in lst
    got = await client.get(f"/api/v1/portfolios/{created['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


async def test_get_missing_portfolio_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/portfolios/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "PORTFOLIO_NOT_FOUND"


async def test_update_portfolio(client, initialized_instance):
    h = await _auth(client)
    created = await _portfolio(client, h)
    resp = await client.patch(
        f"/api/v1/portfolios/{created['id']}", json={"name": "IRA"}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "IRA"
    assert body["currency"] == "USD"  # untouched preserved
    got = (await client.get(f"/api/v1/portfolios/{created['id']}", headers=h)).json()
    assert got["name"] == "IRA"


async def test_delete_portfolio_is_hard_delete(client, initialized_instance):
    h = await _auth(client)
    created = await _portfolio(client, h)
    resp = await client.delete(f"/api/v1/portfolios/{created['id']}", headers=h)
    assert resp.status_code == 204
    got = await client.get(f"/api/v1/portfolios/{created['id']}", headers=h)
    assert got.status_code == 404


async def test_delete_missing_portfolio_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.delete(f"/api/v1/portfolios/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Holding CRUD (API), scoped to a portfolio
# --------------------------------------------------------------------------- #


async def test_add_and_get_holding(client, initialized_instance):
    h = await _auth(client)
    p = await _portfolio(client, h)
    holding = await _holding(client, h, p["id"], quantity="1.5", name="VWRL", symbol="VWRL")
    assert Decimal(holding["quantity"]) == Decimal("1.5")
    assert holding["symbol"] == "VWRL"
    assert holding["portfolio_id"] == p["id"]
    assert holding["latest_unit_price_minor"] is None
    assert holding["value_minor"] == 0
    assert holding["is_demo"] is False
    got = await client.get(f"/api/v1/portfolios/{p['id']}/holdings/{holding['id']}", headers=h)
    assert got.status_code == 200
    assert got.json()["id"] == holding["id"]


async def test_list_holdings(client, initialized_instance):
    h = await _auth(client)
    p = await _portfolio(client, h)
    holding = await _holding(client, h, p["id"], quantity="2")
    lst = (await client.get(f"/api/v1/portfolios/{p['id']}/holdings", headers=h)).json()
    assert any(hd["id"] == holding["id"] for hd in lst["items"])
    assert "next_cursor" in lst


async def test_update_holding(client, initialized_instance):
    h = await _auth(client)
    p = await _portfolio(client, h)
    holding = await _holding(client, h, p["id"], quantity="2", name="Old")
    resp = await client.patch(
        f"/api/v1/portfolios/{p['id']}/holdings/{holding['id']}",
        json={"name": "New", "quantity": "3.25"},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "New"
    assert Decimal(body["quantity"]) == Decimal("3.25")


async def test_delete_holding(client, initialized_instance):
    h = await _auth(client)
    p = await _portfolio(client, h)
    holding = await _holding(client, h, p["id"], quantity="1")
    resp = await client.delete(f"/api/v1/portfolios/{p['id']}/holdings/{holding['id']}", headers=h)
    assert resp.status_code == 204
    got = await client.get(f"/api/v1/portfolios/{p['id']}/holdings/{holding['id']}", headers=h)
    assert got.status_code == 404


async def test_holding_under_wrong_portfolio_is_404(client, initialized_instance):
    """A holding belongs to exactly one portfolio; reaching it through another
    portfolio in the same workspace is a 404, not a leak."""
    h = await _auth(client)
    p1 = await _portfolio(client, h, name="P1")
    p2 = await _portfolio(client, h, name="P2")
    holding = await _holding(client, h, p1["id"], quantity="1")
    assert (
        await client.get(f"/api/v1/portfolios/{p2['id']}/holdings/{holding['id']}", headers=h)
    ).status_code == 404
    assert (
        await client.patch(
            f"/api/v1/portfolios/{p2['id']}/holdings/{holding['id']}",
            json={"name": "X"},
            headers=h,
        )
    ).status_code == 404
    assert (
        await client.delete(f"/api/v1/portfolios/{p2['id']}/holdings/{holding['id']}", headers=h)
    ).status_code == 404
    assert (
        await _record_price(
            client, h, p2["id"], holding["id"], unit_price_minor=1000, as_of="2026-06-01"
        )
    ).status_code == 404


async def test_add_holding_to_missing_portfolio_returns_404(client, initialized_instance):
    h = await _auth(client)
    resp = await client.post(
        f"/api/v1/portfolios/{uuid.uuid4()}/holdings",
        json={"name": "X", "quantity": "1"},
        headers=h,
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# Prices + valuation (API)
# --------------------------------------------------------------------------- #


async def test_record_price_then_value(client, initialized_instance):
    h = await _auth(client)
    p = await _portfolio(client, h)
    holding = await _holding(client, h, p["id"], quantity="1.5")
    resp = await _record_price(
        client, h, p["id"], holding["id"], unit_price_minor=1000, as_of="2026-06-01", source="manual"
    )
    assert resp.status_code == 201
    price = resp.json()
    assert price["unit_price_minor"] == 1000
    assert price["as_of"] == "2026-06-01"
    assert price["source"] == "manual"
    assert price["holding_id"] == holding["id"]
    got = (
        await client.get(f"/api/v1/portfolios/{p['id']}/holdings/{holding['id']}", headers=h)
    ).json()
    assert got["latest_unit_price_minor"] == 1000
    assert got["value_minor"] == 1500  # round(1.5 * 1000)


async def test_portfolio_value_is_sum_of_holdings(client, initialized_instance):
    h = await _auth(client)
    p = await _portfolio(client, h)
    h1 = await _holding(client, h, p["id"], quantity="1.5", name="A")
    h2 = await _holding(client, h, p["id"], quantity="0.15", name="B")
    await _record_price(client, h, p["id"], h1["id"], unit_price_minor=1000, as_of="2026-06-01")
    await _record_price(client, h, p["id"], h2["id"], unit_price_minor=6_000_000, as_of="2026-06-01")
    got = (await client.get(f"/api/v1/portfolios/{p['id']}", headers=h)).json()
    assert got["value_minor"] == 1500 + 900_000
    assert got["holding_count"] == 2


# --------------------------------------------------------------------------- #
# Cross-workspace isolation (API)
# --------------------------------------------------------------------------- #


async def test_cross_workspace_portfolio_is_404(client, initialized_instance, user_factory, db):
    from pecunia.models import Workspace, WorkspaceMembership

    h = await _auth(client)
    created = await _portfolio(client, h)
    holding = await _holding(client, h, created["id"], quantity="1")

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

    assert (await client.get(f"/api/v1/portfolios/{created['id']}", headers=other_h)).status_code == 404
    assert (
        await client.patch(
            f"/api/v1/portfolios/{created['id']}", json={"name": "Hijacked"}, headers=other_h
        )
    ).status_code == 404
    assert (
        await client.delete(f"/api/v1/portfolios/{created['id']}", headers=other_h)
    ).status_code == 404
    assert (
        await client.get(f"/api/v1/portfolios/{created['id']}/holdings", headers=other_h)
    ).status_code == 404
    assert (
        await client.get(
            f"/api/v1/portfolios/{created['id']}/holdings/{holding['id']}", headers=other_h
        )
    ).status_code == 404
    lst = (await client.get("/api/v1/portfolios", headers=other_h)).json()
    assert all(p["id"] != created["id"] for p in lst["items"])


# --------------------------------------------------------------------------- #
# Audit + activity
# --------------------------------------------------------------------------- #


async def test_portfolio_lifecycle_is_audited(client, initialized_instance, db):
    h = await _auth(client)
    p = await _portfolio(client, h)
    holding = await _holding(client, h, p["id"], quantity="1")
    await _record_price(client, h, p["id"], holding["id"], unit_price_minor=100, as_of="2026-01-01")
    await client.patch(f"/api/v1/portfolios/{p['id']}", json={"name": "Renamed"}, headers=h)
    await client.delete(f"/api/v1/portfolios/{p['id']}/holdings/{holding['id']}", headers=h)
    await client.delete(f"/api/v1/portfolios/{p['id']}", headers=h)
    actions = (await db.execute(sa.select(AuditEvent.action))).scalars().all()
    for expected in (
        "portfolio.created",
        "portfolio.updated",
        "portfolio.deleted",
        "holding.created",
        "holding.deleted",
        "holding_price.recorded",
    ):
        assert expected in actions
    templates = (await db.execute(sa.select(ActivityEntry.template_key))).scalars().all()
    assert "activity.portfolio.created" in templates


# --------------------------------------------------------------------------- #
# Service-level valuation math (Decimal, per CONVENTIONS §4 — never float)
# --------------------------------------------------------------------------- #


async def _svc_portfolio(db, ws_id, *, currency="USD", name="P"):
    p = Portfolio(id=uuid.uuid4(), workspace_id=ws_id, name=name, currency=currency)
    db.add(p)
    await db.flush()
    return p


async def _svc_holding(db, ws_id, portfolio, *, quantity, name="H"):
    hd = Holding(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        portfolio_id=portfolio.id,
        name=name,
        quantity=Decimal(quantity),
    )
    db.add(hd)
    await db.flush()
    return hd


async def _svc_price(db, ws_id, holding, *, unit_price_minor, as_of):
    pr = HoldingPrice(
        id=uuid.uuid4(),
        workspace_id=ws_id,
        holding_id=holding.id,
        unit_price_minor=unit_price_minor,
        as_of=as_of,
    )
    db.add(pr)
    await db.flush()
    return pr


async def test_holding_value_minor_fractional_shares(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    p = await _svc_portfolio(db, ws_id)
    hd = await _svc_holding(db, ws_id, p, quantity="1.5")
    await _svc_price(db, ws_id, hd, unit_price_minor=1000, as_of=date(2026, 6, 1))
    # 1.5 shares * $10.00 = $15.00 -> 1500 minor units, exact
    assert await PortfolioService(db).holding_value_minor(hd) == 1500


async def test_holding_value_minor_fractional_crypto(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    p = await _svc_portfolio(db, ws_id)
    hd = await _svc_holding(db, ws_id, p, quantity="0.15")
    await _svc_price(db, ws_id, hd, unit_price_minor=6_000_000, as_of=date(2026, 6, 1))
    # 0.15 BTC * $60,000 = $9,000 -> 900000 minor units, exact
    assert await PortfolioService(db).holding_value_minor(hd) == 900_000


async def test_holding_value_minor_is_int_not_float(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    p = await _svc_portfolio(db, ws_id)
    hd = await _svc_holding(db, ws_id, p, quantity="1.5")
    await _svc_price(db, ws_id, hd, unit_price_minor=1000, as_of=date(2026, 6, 1))
    value = await PortfolioService(db).holding_value_minor(hd)
    assert type(value) is int


async def test_holding_value_minor_no_price_is_zero(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    p = await _svc_portfolio(db, ws_id)
    hd = await _svc_holding(db, ws_id, p, quantity="3")
    assert await PortfolioService(db).holding_value_minor(hd) == 0


async def test_holding_value_minor_uses_latest_price_on_or_before_date(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    p = await _svc_portfolio(db, ws_id)
    hd = await _svc_holding(db, ws_id, p, quantity="2")
    await _svc_price(db, ws_id, hd, unit_price_minor=1000, as_of=date(2026, 1, 1))
    await _svc_price(db, ws_id, hd, unit_price_minor=1500, as_of=date(2026, 6, 1))
    svc = PortfolioService(db)
    # before any price -> 0
    assert await svc.holding_value_minor(hd, on_date=date(2025, 12, 31)) == 0
    # between the two prices -> the earlier one
    assert await svc.holding_value_minor(hd, on_date=date(2026, 3, 1)) == 2000
    # on/after the later -> the later
    assert await svc.holding_value_minor(hd, on_date=date(2026, 6, 1)) == 3000
    # no date -> latest of all
    assert await svc.holding_value_minor(hd) == 3000


async def test_portfolio_value_minor_sums_holdings(db, initialized_instance):
    ws_id = initialized_instance["workspace_id"]
    p = await _svc_portfolio(db, ws_id)
    h1 = await _svc_holding(db, ws_id, p, quantity="1.5", name="A")
    h2 = await _svc_holding(db, ws_id, p, quantity="0.15", name="B")
    h3 = await _svc_holding(db, ws_id, p, quantity="10", name="NoPrice")  # contributes 0
    await _svc_price(db, ws_id, h1, unit_price_minor=1000, as_of=date(2026, 6, 1))
    await _svc_price(db, ws_id, h2, unit_price_minor=6_000_000, as_of=date(2026, 6, 1))
    assert await PortfolioService(db).portfolio_value_minor(p) == 1500 + 900_000
    _ = h3
