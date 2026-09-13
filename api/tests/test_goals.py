import uuid
from datetime import date

import sqlalchemy as sa

from pecunia.models import (
    Account,
    Holding,
    HoldingPrice,
    Portfolio,
    ScheduledTransaction,
    Workspace,
    WorkspaceMembership,
)
from pecunia.services.goals import GoalService

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}
TODAY = date(2026, 9, 13)


async def _auth(client):
    return {
        "Authorization": f"Bearer {(await client.post('/api/v1/auth/login', json=LOGIN)).json()['access_token']}"
    }


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _goal(client, h, **overrides):
    body = {"name": "Emergency fund", "target_minor": 200_000, "currency": "USD"}
    body.update(overrides)
    return await client.post("/api/v1/goals", json=body, headers=h)


async def _account(db, ws_id, *, currency="USD", initial=0, name="Checking"):
    acc = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type="checking",
        currency=currency, initial_balance_minor=initial,
    )
    db.add(acc)
    await db.flush()
    return acc


async def _scheduled(
    db, ws_id, account, *, description, amount, next_due, currency="USD", frequency="monthly",
):
    st = ScheduledTransaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description=description,
        frequency=frequency, next_due=next_due, is_active=True,
    )
    db.add(st)
    await db.flush()
    return st


async def _portfolio(db, ws_id, *, currency="USD", name="Brokerage"):
    portfolio = Portfolio(id=uuid.uuid4(), workspace_id=ws_id, name=name, currency=currency)
    db.add(portfolio)
    await db.flush()
    return portfolio


async def _holding_with_price(db, ws_id, portfolio, *, quantity="2", unit_price_minor=500, as_of=TODAY):
    holding = Holding(
        id=uuid.uuid4(), workspace_id=ws_id, portfolio_id=portfolio.id,
        name="Fund", quantity=quantity,
    )
    db.add(holding)
    await db.flush()
    db.add(
        HoldingPrice(
            id=uuid.uuid4(), workspace_id=ws_id, holding_id=holding.id,
            unit_price_minor=unit_price_minor, as_of=as_of,
        )
    )
    await db.flush()
    return holding


async def _other_workspace_headers(client, user_factory, db):
    other_user = await user_factory(email="other_ws@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other_user.id, role="owner"))
    await db.commit()
    token = (
        await client.post(
            "/api/v1/auth/login",
            json={"email": "other_ws@example.com", "password": "correct horse battery staple"},
        )
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- #
# CRUD (API)
# --------------------------------------------------------------------------- #


async def test_create_manual_goal(client, initialized_instance):
    h = await _auth(client)
    resp = await _goal(
        client, h, source_kind="manual", manual_current_minor=50_000, target_minor=200_000,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Emergency fund"
    assert body["source_kind"] == "manual"
    assert body["manual_current_minor"] == 50_000
    assert body["source_id"] is None
    assert body["progress"] == {"current_minor": 50_000, "target_minor": 200_000, "pct_bps": 2500}
    assert body["eta"]["on_track"] is False or body["eta"]["on_track"] is True  # shape only here
    assert uuid.UUID(body["id"])


async def test_create_goal_requires_auth(client, initialized_instance):
    resp = await client.post(
        "/api/v1/goals", json={"name": "x", "target_minor": 1, "currency": "USD"}
    )
    assert resp.status_code == 401


async def test_create_account_goal(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=80_000)
    await db.commit()
    h = await _auth(client)

    resp = await _goal(
        client, h, source_kind="account", source_id=str(acc.id), currency="USD",
        target_minor=100_000,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["source_kind"] == "account"
    assert body["source_id"] == str(acc.id)
    assert body["progress"]["current_minor"] == 80_000
    assert body["progress"]["pct_bps"] == 8000


async def test_create_account_goal_currency_mismatch(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="EUR")
    await db.commit()
    h = await _auth(client)

    resp = await _goal(client, h, source_kind="account", source_id=str(acc.id), currency="USD")
    assert resp.status_code == 422
    assert resp.json()["detail"] == "GOAL_CURRENCY_MISMATCH"


async def test_create_account_goal_missing_account(client, initialized_instance):
    h = await _auth(client)
    resp = await _goal(
        client, h, source_kind="account", source_id=str(uuid.uuid4()), currency="USD",
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "ACCOUNT_NOT_FOUND"


async def test_create_account_goal_requires_source_id(client, initialized_instance):
    h = await _auth(client)
    resp = await _goal(client, h, source_kind="account", currency="USD")
    assert resp.status_code == 422
    assert resp.json()["detail"] == "GOAL_SOURCE_REQUIRED"


async def test_create_portfolio_goal(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    portfolio = await _portfolio(db, ws_id, currency="USD")
    await _holding_with_price(db, ws_id, portfolio, quantity="2", unit_price_minor=500)
    await db.commit()
    h = await _auth(client)

    resp = await _goal(
        client, h, source_kind="portfolio", source_id=str(portfolio.id), currency="USD",
        target_minor=2_000,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["progress"]["current_minor"] == 1_000
    assert body["progress"]["pct_bps"] == 5000


async def test_create_portfolio_goal_currency_mismatch(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    portfolio = await _portfolio(db, ws_id, currency="EUR")
    await db.commit()
    h = await _auth(client)

    resp = await _goal(
        client, h, source_kind="portfolio", source_id=str(portfolio.id), currency="USD",
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "GOAL_CURRENCY_MISMATCH"


async def test_create_portfolio_goal_missing_portfolio(client, initialized_instance):
    h = await _auth(client)
    resp = await _goal(
        client, h, source_kind="portfolio", source_id=str(uuid.uuid4()), currency="USD",
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "PORTFOLIO_NOT_FOUND"


async def test_create_net_worth_goal(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    await db.commit()
    h = await _auth(client)

    resp = await _goal(client, h, source_kind="net_worth", currency="USD", target_minor=150_000)
    assert resp.status_code == 201
    body = resp.json()
    assert body["progress"]["current_minor"] == 100_000


async def test_list_goals(client, initialized_instance):
    h = await _auth(client)
    await _goal(client, h, source_kind="manual", manual_current_minor=1_000)
    await _goal(client, h, source_kind="manual", manual_current_minor=2_000, name="Vacation")

    resp = await client.get("/api/v1/goals", headers=h)
    assert resp.status_code == 200
    names = {item["name"] for item in resp.json()["items"]}
    assert names == {"Emergency fund", "Vacation"}


async def test_get_goal(client, initialized_instance):
    h = await _auth(client)
    created = (await _goal(client, h, source_kind="manual", manual_current_minor=1_000)).json()

    resp = await client.get(f"/api/v1/goals/{created['id']}", headers=h)
    assert resp.status_code == 200
    assert resp.json()["id"] == created["id"]


async def test_get_goal_not_found(client, initialized_instance):
    h = await _auth(client)
    resp = await client.get(f"/api/v1/goals/{uuid.uuid4()}", headers=h)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "GOAL_NOT_FOUND"


async def test_update_goal_manual_current(client, initialized_instance):
    h = await _auth(client)
    created = (await _goal(client, h, source_kind="manual", manual_current_minor=1_000)).json()

    resp = await client.patch(
        f"/api/v1/goals/{created['id']}", json={"manual_current_minor": 5_000}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["manual_current_minor"] == 5_000
    assert body["progress"]["current_minor"] == 5_000


async def test_update_goal_switch_to_account_requires_matching_currency(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="EUR")
    await db.commit()
    h = await _auth(client)
    created = (await _goal(client, h, source_kind="manual", currency="USD")).json()

    resp = await client.patch(
        f"/api/v1/goals/{created['id']}",
        json={"source_kind": "account", "source_id": str(acc.id)},
        headers=h,
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "GOAL_CURRENCY_MISMATCH"


async def test_update_goal_clears_manual_current_when_switching_away_from_manual(
    client, db, initialized_instance
):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=42_000)
    await db.commit()
    h = await _auth(client)
    created = (
        await _goal(client, h, source_kind="manual", manual_current_minor=1_000, currency="USD")
    ).json()

    resp = await client.patch(
        f"/api/v1/goals/{created['id']}",
        json={"source_kind": "account", "source_id": str(acc.id)},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["manual_current_minor"] is None
    assert body["source_id"] == str(acc.id)
    assert body["progress"]["current_minor"] == 42_000


async def test_delete_goal(client, initialized_instance):
    h = await _auth(client)
    created = (await _goal(client, h, source_kind="manual")).json()

    resp = await client.delete(f"/api/v1/goals/{created['id']}", headers=h)
    assert resp.status_code == 204

    resp = await client.get(f"/api/v1/goals/{created['id']}", headers=h)
    assert resp.status_code == 404


async def test_goal_is_workspace_scoped(client, db, user_factory, initialized_instance):
    h = await _auth(client)
    created = (await _goal(client, h, source_kind="manual")).json()

    other_headers = await _other_workspace_headers(client, user_factory, db)
    resp = await client.get(f"/api/v1/goals/{created['id']}", headers=other_headers)
    assert resp.status_code == 404


# --------------------------------------------------------------------------- #
# GoalService.progress (direct — deterministic today)
# --------------------------------------------------------------------------- #


async def test_progress_manual_source(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=200_000, currency="USD",
        source_kind="manual", manual_current_minor=50_000,
    )
    result = await svc.progress(goal, today=TODAY)
    assert result == {"current_minor": 50_000, "target_minor": 200_000, "pct_bps": 2500}


async def test_progress_account_source(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=100_000, currency="USD",
        source_kind="account", source_id=acc.id,
    )
    result = await svc.progress(goal, today=TODAY)
    assert result == {"current_minor": 100_000, "target_minor": 100_000, "pct_bps": 10_000}


async def test_progress_portfolio_source(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    portfolio = await _portfolio(db, ws_id, currency="USD")
    await _holding_with_price(db, ws_id, portfolio, quantity="2", unit_price_minor=500)
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=2_000, currency="USD",
        source_kind="portfolio", source_id=portfolio.id,
    )
    result = await svc.progress(goal, today=TODAY)
    assert result == {"current_minor": 1_000, "target_minor": 2_000, "pct_bps": 5000}


async def test_progress_net_worth_source(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=150_000, currency="USD", source_kind="net_worth",
    )
    result = await svc.progress(goal, today=TODAY)
    assert result == {"current_minor": 100_000, "target_minor": 150_000, "pct_bps": 6667}


# --------------------------------------------------------------------------- #
# GoalService.eta (direct — deterministic today, reuses ForecastService)
# --------------------------------------------------------------------------- #


async def test_eta_already_reached_returns_today(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=100_000, currency="USD",
        source_kind="manual", manual_current_minor=200_000,
    )
    result = await svc.eta(goal, today=TODAY)
    assert result == {"reached_on": TODAY, "on_track": True}


async def test_eta_net_worth_reaches_target_within_horizon(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=20_000, next_due=date(2026, 10, 1),
    )
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=150_000, currency="USD", source_kind="net_worth",
    )
    result = await svc.eta(goal, today=TODAY)
    # month1=120k, month2=140k, month3=160k -> reached on month3's month-end.
    assert result == {"reached_on": date(2026, 12, 31), "on_track": True}


async def test_eta_account_source_uses_cash_delta_approximation(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=20_000, next_due=date(2026, 10, 1),
    )
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=150_000, currency="USD",
        source_kind="account", source_id=acc.id,
    )
    result = await svc.eta(goal, today=TODAY)
    assert result == {"reached_on": date(2026, 12, 31), "on_track": True}


async def test_eta_not_on_track_within_horizon(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    svc = GoalService(db)
    goal = await svc.create(
        ws_id, name="G", target_minor=10_000_000, currency="USD",
        source_kind="manual", manual_current_minor=100_000,
    )
    result = await svc.eta(goal, today=TODAY)
    assert result == {"reached_on": None, "on_track": False}
