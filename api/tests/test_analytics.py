import uuid
from datetime import UTC, date, datetime, timedelta

import sqlalchemy as sa

from pecunia.models import (
    Account,
    Asset,
    AssetValuation,
    Budget,
    Category,
    Contact,
    Loan,
    NetWorthSnapshot,
    ScheduledTransaction,
    Subscription,
    Transaction,
    Transfer,
    Workspace,
    WorkspaceMembership,
)
from pecunia.services.analytics import AnalyticsService

LOGIN = {"email": "owner@example.com", "password": "correct horse battery staple"}


async def _auth(client):
    token = (await client.post("/api/v1/auth/login", json=LOGIN)).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _account(db, ws_id, *, currency="USD", initial=0, name="Acc"):
    acc = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type="checking",
        currency=currency, initial_balance_minor=initial,
    )
    db.add(acc)
    await db.flush()
    return acc


async def _tx(
    db, ws_id, account, *, amount, on, currency="USD",
    deleted=False, category_id=None, contact_id=None, transfer_id=None,
):
    tx = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description="t", occurred_on=on,
        category_id=category_id, contact_id=contact_id, transfer_id=transfer_id,
        deleted_at=datetime.now(UTC) if deleted else None,
    )
    db.add(tx)
    await db.flush()
    return tx


async def _category(db, ws_id, *, name, kind="expense", color="#22d3ee"):
    cat = Category(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, kind=kind, color=color,
    )
    db.add(cat)
    await db.flush()
    return cat


async def _contact(db, ws_id, *, name):
    contact = Contact(id=uuid.uuid4(), workspace_id=ws_id, name=name)
    db.add(contact)
    await db.flush()
    return contact


async def _transfer_pair(db, ws_id, from_acc, to_acc, *, amount, on, currency="USD"):
    """A first-class transfer: a Transfer row plus its two signed legs, both
    carrying transfer_id (which analytics income/spend must exclude)."""
    transfer = Transfer(
        id=uuid.uuid4(), workspace_id=ws_id,
        from_account_id=from_acc.id, to_account_id=to_acc.id,
        amount_minor=amount, currency=currency, description="xfer", occurred_on=on,
    )
    db.add(transfer)
    await db.flush()
    await _tx(db, ws_id, from_acc, amount=-amount, on=on, currency=currency, transfer_id=transfer.id)
    await _tx(db, ws_id, to_acc, amount=amount, on=on, currency=currency, transfer_id=transfer.id)
    return transfer


async def _other_workspace(db, user_factory):
    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    return other_ws


# ------------------------------------------------------------------ cashflow

FROM = date(2026, 3, 1)
TO = date(2026, 5, 31)


async def _cashflow_fixture(db, ws_id):
    acc = await _account(db, ws_id, currency="USD", name="A")
    acc_b = await _account(db, ws_id, currency="USD", name="B")
    # March: income 10_000 + 5_000 = 15_000; spend 3_000
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 3, 5))
    await _tx(db, ws_id, acc, amount=5_000, on=date(2026, 3, 20))
    await _tx(db, ws_id, acc, amount=-3_000, on=date(2026, 3, 10))
    # a soft-deleted March expense must NOT count
    await _tx(db, ws_id, acc, amount=-99_999, on=date(2026, 3, 1), deleted=True)
    # April: only a transfer pair (must contribute 0 to income AND spend)
    await _transfer_pair(db, ws_id, acc, acc_b, amount=4_000, on=date(2026, 4, 15))
    # May: spend 2_000, no income
    await _tx(db, ws_id, acc, amount=-2_000, on=date(2026, 5, 1))
    # a second-currency account's income must never merge into USD
    eur = await _account(db, ws_id, currency="EUR", name="E")
    await _tx(db, ws_id, eur, amount=7_000, on=date(2026, 3, 5), currency="EUR")


async def test_cashflow_buckets_by_month_per_currency(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _cashflow_fixture(db, ws_id)

    result = await AnalyticsService(db).cashflow(ws_id, from_date=FROM, to_date=TO)

    assert set(result) == {"USD", "EUR"}
    # a continuous month axis: March, April, May — even the empty middle month
    usd = result["USD"]
    assert [r["period_start"] for r in usd] == [date(2026, 3, 1), date(2026, 4, 1), date(2026, 5, 1)]
    assert usd[0] == {"period_start": date(2026, 3, 1), "income_minor": 15_000, "spend_minor": 3_000}
    # April holds ONLY a transfer pair -> both legs excluded -> a present zero row
    assert usd[1] == {"period_start": date(2026, 4, 1), "income_minor": 0, "spend_minor": 0}
    assert usd[2] == {"period_start": date(2026, 5, 1), "income_minor": 0, "spend_minor": 2_000}
    # EUR stays separate, never summed into USD
    assert result["EUR"][0] == {"period_start": date(2026, 3, 1), "income_minor": 7_000, "spend_minor": 0}


async def test_cashflow_transfer_pair_contributes_zero(db, initialized_instance):
    """The defining exclusion: a transfer's two legs add 0 to income and spend,
    never inflating a month that also holds a real transaction."""
    ws_id = await _ws_id(db, initialized_instance)
    acc_a = await _account(db, ws_id, currency="USD", name="A")
    acc_b = await _account(db, ws_id, currency="USD", name="B")
    await _tx(db, ws_id, acc_a, amount=1_000, on=date(2026, 4, 3))  # real income
    await _transfer_pair(db, ws_id, acc_a, acc_b, amount=50_000, on=date(2026, 4, 10))

    result = await AnalyticsService(db).cashflow(
        ws_id, from_date=date(2026, 4, 1), to_date=date(2026, 4, 30)
    )

    # the transfer's +50_000/-50_000 legs are excluded: income is the 1_000 real
    # tx only (not 51_000), spend is 0 (not 50_000)
    assert result == {"USD": [{"period_start": date(2026, 4, 1), "income_minor": 1_000, "spend_minor": 0}]}


async def test_cashflow_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    await _cashflow_fixture(db, ws_id)
    other_ws = await _other_workspace(db, user_factory)
    other_acc = await _account(db, other_ws.id, currency="USD", name="X")
    await _tx(db, other_ws.id, other_acc, amount=1_000_000, on=date(2026, 3, 5))

    result = await AnalyticsService(db).cashflow(ws_id, from_date=FROM, to_date=TO)
    assert result["USD"][0]["income_minor"] == 15_000  # not 1_015_000


# --------------------------------------------------------- spending by category


async def test_spending_by_category_groups_sorted_with_uncategorized(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    acc_b = await _account(db, ws_id, currency="USD", name="B")
    groceries = await _category(db, ws_id, name="AnGroceries", color="#22d3ee")
    dining = await _category(db, ws_id, name="AnDining", color="#a78bfa")
    salary = await _category(db, ws_id, name="AnSalary", kind="income", color="#fbbf24")
    # groceries 4_000, dining 2_000, uncategorized 1_500
    await _tx(db, ws_id, acc, amount=-3_000, on=date(2026, 3, 3), category_id=groceries.id)
    await _tx(db, ws_id, acc, amount=-1_000, on=date(2026, 3, 9), category_id=groceries.id)
    await _tx(db, ws_id, acc, amount=-2_000, on=date(2026, 3, 4), category_id=dining.id)
    await _tx(db, ws_id, acc, amount=-1_500, on=date(2026, 3, 5))  # null category
    # income and a soft-deleted expense must not appear
    await _tx(db, ws_id, acc, amount=9_000, on=date(2026, 3, 6), category_id=salary.id)
    await _tx(db, ws_id, acc, amount=-9_999, on=date(2026, 3, 7), category_id=groceries.id, deleted=True)
    # a transfer leg carrying a category must be excluded
    await _transfer_pair(db, ws_id, acc, acc_b, amount=8_000, on=date(2026, 3, 8))

    result = await AnalyticsService(db).spending_by_category(
        ws_id, from_date=date(2026, 3, 1), to_date=date(2026, 3, 31)
    )

    usd = result["USD"]
    assert [r["spend_minor"] for r in usd] == [4_000, 2_000, 1_500]  # sorted desc
    assert usd[0] == {"category_id": groceries.id, "name": "AnGroceries", "color": "#22d3ee", "spend_minor": 4_000}
    assert usd[1] == {"category_id": dining.id, "name": "AnDining", "color": "#a78bfa", "spend_minor": 2_000}
    assert usd[2] == {"category_id": None, "name": "Uncategorized", "color": None, "spend_minor": 1_500}


async def test_spending_by_category_per_currency(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    usd_acc = await _account(db, ws_id, currency="USD")
    eur_acc = await _account(db, ws_id, currency="EUR", name="E")
    cat = await _category(db, ws_id, name="AnShared", color="#38bdf8")
    await _tx(db, ws_id, usd_acc, amount=-1_000, on=date(2026, 3, 3), category_id=cat.id)
    await _tx(db, ws_id, eur_acc, amount=-800, on=date(2026, 3, 3), currency="EUR", category_id=cat.id)

    result = await AnalyticsService(db).spending_by_category(
        ws_id, from_date=date(2026, 3, 1), to_date=date(2026, 3, 31)
    )
    assert result["USD"] == [{"category_id": cat.id, "name": "AnShared", "color": "#38bdf8", "spend_minor": 1_000}]
    assert result["EUR"] == [{"category_id": cat.id, "name": "AnShared", "color": "#38bdf8", "spend_minor": 800}]


# ----------------------------------------------------------- spending by contact


async def test_spending_by_contact_groups_sorted_with_no_contact(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    acc_b = await _account(db, ws_id, currency="USD", name="B")
    acme = await _contact(db, ws_id, name="Acme")
    shop = await _contact(db, ws_id, name="Shop")
    await _tx(db, ws_id, acc, amount=-3_000, on=date(2026, 3, 3), contact_id=acme.id)
    await _tx(db, ws_id, acc, amount=-1_000, on=date(2026, 3, 9), contact_id=acme.id)
    await _tx(db, ws_id, acc, amount=-2_000, on=date(2026, 3, 4), contact_id=shop.id)
    await _tx(db, ws_id, acc, amount=-1_500, on=date(2026, 3, 5))  # no contact
    await _tx(db, ws_id, acc, amount=-9_999, on=date(2026, 3, 7), contact_id=acme.id, deleted=True)
    await _transfer_pair(db, ws_id, acc, acc_b, amount=8_000, on=date(2026, 3, 8))

    result = await AnalyticsService(db).spending_by_contact(
        ws_id, from_date=date(2026, 3, 1), to_date=date(2026, 3, 31)
    )

    usd = result["USD"]
    assert [r["spend_minor"] for r in usd] == [4_000, 2_000, 1_500]
    assert usd[0] == {"contact_id": acme.id, "name": "Acme", "spend_minor": 4_000}
    assert usd[1] == {"contact_id": shop.id, "name": "Shop", "spend_minor": 2_000}
    assert usd[2] == {"contact_id": None, "name": "No contact", "spend_minor": 1_500}


# -------------------------------------------------------------- net worth series


async def test_net_worth_series_captures_today_on_read(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))
    today = date(2026, 9, 12)

    # no snapshots exist yet
    assert await db.scalar(sa.select(sa.func.count()).select_from(NetWorthSnapshot)) == 0

    result = await AnalyticsService(db).net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 9, 30), today=today
    )

    # a snapshot for `today` was captured on read
    row = await db.scalar(
        sa.select(NetWorthSnapshot).where(
            NetWorthSnapshot.workspace_id == ws_id,
            NetWorthSnapshot.currency == "USD",
            NetWorthSnapshot.captured_on == today,
        )
    )
    assert row is not None
    assert row.net_worth_minor == 110_000
    # and it comes back in the series
    assert result["USD"][-1] == {"date": today, "net_worth_minor": 110_000}


async def test_net_worth_series_returns_prior_points_and_is_per_currency(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    usd = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, usd, amount=10_000, on=date(2026, 1, 15))
    eur_asset = await _asset_with_valuation(db, ws_id)
    today = date(2026, 9, 12)
    svc = AnalyticsService(db)

    result = await svc.net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 9, 30), today=today
    )

    assert set(result) == {"USD", "EUR"}
    assert result["USD"] == [{"date": today, "net_worth_minor": 110_000}]
    assert result["EUR"] == [{"date": today, "net_worth_minor": 40_000}]
    assert eur_asset  # referenced


async def _asset_with_valuation(db, ws_id):
    asset = Asset(id=uuid.uuid4(), workspace_id=ws_id, name="Y", type="other", currency="EUR")
    db.add(asset)
    await db.flush()
    db.add(AssetValuation(
        id=uuid.uuid4(), workspace_id=ws_id, asset_id=asset.id,
        value_minor=40_000, as_of=date(2026, 4, 1),
    ))
    await db.flush()
    return asset


async def test_net_worth_series_does_not_duplicate_existing_today(db, initialized_instance):
    from pecunia.services.snapshots import SnapshotService

    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))
    today = date(2026, 9, 12)
    await SnapshotService(db).capture(ws_id, today)  # today already snapshotted

    await AnalyticsService(db).net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 9, 30), today=today
    )

    count = await db.scalar(
        sa.select(sa.func.count()).select_from(NetWorthSnapshot).where(
            NetWorthSnapshot.captured_on == today, NetWorthSnapshot.currency == "USD"
        )
    )
    assert count == 1


async def test_net_worth_series_refreshes_today_on_reread(db, initialized_instance):
    """Reading refreshes today's snapshot every time, so same-day activity added
    AFTER a first read shows up on the latest point on the next read — the
    snapshot is refreshed, never left stale (the deferred-polish fix)."""
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    today = date(2026, 9, 12)
    svc = AnalyticsService(db)

    first = await svc.net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 9, 30), today=today
    )
    assert first["USD"][-1] == {"date": today, "net_worth_minor": 100_000}

    # same-day activity recorded AFTER the first read
    await _tx(db, ws_id, acc, amount=25_000, on=today)

    second = await svc.net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 9, 30), today=today
    )

    # today's point reflects the new activity (not the stale 100_000), and it is
    # still a single row for the day (idempotent per-currency upsert).
    assert second["USD"][-1] == {"date": today, "net_worth_minor": 125_000}
    count = await db.scalar(
        sa.select(sa.func.count()).select_from(NetWorthSnapshot).where(
            NetWorthSnapshot.captured_on == today, NetWorthSnapshot.currency == "USD"
        )
    )
    assert count == 1


# -------------------------------------------------------- net worth composition


async def _loan(db, ws_id, *, direction, principal, currency="USD", name="Loan"):
    loan = Loan(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, direction=direction,
        principal_minor=principal, currency=currency,
    )
    db.add(loan)
    await db.flush()
    return loan


async def test_net_worth_composition_point_per_month_with_parts(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))
    asset = Asset(id=uuid.uuid4(), workspace_id=ws_id, name="X", type="other", currency="USD")
    db.add(asset)
    await db.flush()
    db.add(AssetValuation(
        id=uuid.uuid4(), workspace_id=ws_id, asset_id=asset.id,
        value_minor=5_000, as_of=date(2026, 3, 10),
    ))
    await db.flush()
    await _loan(db, ws_id, direction="borrowed", principal=20_000)

    result = await AnalyticsService(db).net_worth_composition(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 4, 30)
    )

    usd = result["USD"]
    # one point per month-end across the range (a continuous month axis)
    assert [r["period_start"] for r in usd] == [
        date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30),
    ]
    # Jan: cash = initial + the Jan-15 tx; no asset valuation yet; borrowed loan
    # as a negative debts term.
    assert usd[0] == {
        "period_start": date(2026, 1, 31),
        "cash_minor": 110_000, "assets_minor": 0,
        "investments_minor": 0, "debts_minor": -20_000,
    }
    # Mar: the asset valuation (as_of 03-10) now counts.
    assert usd[2] == {
        "period_start": date(2026, 3, 31),
        "cash_minor": 110_000, "assets_minor": 5_000,
        "investments_minor": 0, "debts_minor": -20_000,
    }


async def test_net_worth_composition_per_currency_and_workspace_scoped(
    db, initialized_instance, user_factory
):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=50_000)
    eur_asset = await _asset_with_valuation(db, ws_id)  # EUR 40_000 as_of 2026-04-01

    other_ws = await _other_workspace(db, user_factory)
    await _account(db, other_ws.id, currency="USD", initial=999_000)

    result = await AnalyticsService(db).net_worth_composition(
        ws_id, from_date=date(2026, 3, 1), to_date=date(2026, 5, 31)
    )

    assert set(result) == {"USD", "EUR"}
    # USD reflects only this workspace's account (never the other's 999_000)
    assert all(p["cash_minor"] == 50_000 for p in result["USD"])
    # EUR gets a continuous axis; the asset appears once its valuation date lands
    eur = result["EUR"]
    assert [p["period_start"] for p in eur] == [
        date(2026, 3, 31), date(2026, 4, 30), date(2026, 5, 31),
    ]
    assert eur[0]["assets_minor"] == 0  # before 2026-04-01
    assert eur[1]["assets_minor"] == 40_000  # on/after 2026-04-01
    assert eur[2]["assets_minor"] == 40_000
    assert eur_asset


# ------------------------------------------------------------------- endpoints


async def test_endpoints_require_auth(client, initialized_instance):
    for path in (
        "cashflow", "spending-by-category", "spending-by-contact",
        "net-worth", "net-worth-composition", "upcoming",
    ):
        resp = await client.get(f"/api/v1/analytics/{path}")
        assert resp.status_code == 401


async def test_cashflow_endpoint_returns_per_currency(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _cashflow_fixture(db, ws_id)
    await db.commit()  # the request runs in its own session — commit so it sees the data
    h = await _auth(client)

    resp = await client.get(
        "/api/v1/analytics/cashflow", params={"from": "2026-03-01", "to": "2026-05-31"}, headers=h
    )
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"USD", "EUR"}
    assert body["USD"][0] == {"period_start": "2026-03-01", "income_minor": 15_000, "spend_minor": 3_000}
    assert body["USD"][1]["income_minor"] == 0 and body["USD"][1]["spend_minor"] == 0


async def test_endpoints_default_date_range_ok(client, initialized_instance):
    """Omitting from/to falls back to the router's last-12-months default."""
    h = await _auth(client)
    for path in (
        "cashflow", "spending-by-category", "spending-by-contact",
        "net-worth", "net-worth-composition", "upcoming",
    ):
        resp = await client.get(f"/api/v1/analytics/{path}", headers=h)
        assert resp.status_code == 200
        assert isinstance(resp.json(), dict)


async def test_net_worth_endpoint_persists_today_snapshot(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))
    await db.commit()
    h = await _auth(client)

    resp = await client.get("/api/v1/analytics/net-worth", headers=h)
    assert resp.status_code == 200

    # the router committed the lazily-captured snapshot -> a fresh read sees it
    row = await db.scalar(
        sa.select(NetWorthSnapshot).where(
            NetWorthSnapshot.workspace_id == ws_id, NetWorthSnapshot.currency == "USD"
        )
    )
    assert row is not None
    assert row.net_worth_minor == 110_000


async def test_net_worth_composition_endpoint_returns_per_currency(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))
    await db.commit()  # the request runs in its own session — commit so it sees the data
    h = await _auth(client)

    resp = await client.get(
        "/api/v1/analytics/net-worth-composition",
        params={"from": "2026-01-01", "to": "2026-03-31"}, headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"USD"}
    assert body["USD"][0]["period_start"] == "2026-01-31"
    assert body["USD"][0]["cash_minor"] == 110_000
    assert body["USD"][-1]["period_start"] == "2026-03-31"


# ---------------------------------------------------------------------- upcoming

TODAY = date(2026, 9, 13)


async def _scheduled(
    db, ws_id, account, *, description, amount, next_due,
    currency="USD", is_active=True, frequency="monthly",
):
    st = ScheduledTransaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description=description,
        frequency=frequency, next_due=next_due, is_active=is_active,
    )
    db.add(st)
    await db.flush()
    return st


async def _subscription(
    db, ws_id, *, name, amount, next_renewal,
    currency="USD", status="active", billing_frequency="monthly",
):
    sub = Subscription(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, amount_minor=amount,
        currency=currency, billing_frequency=billing_frequency,
        next_renewal=next_renewal, status=status,
    )
    db.add(sub)
    await db.flush()
    return sub


async def _due_loan(
    db, ws_id, *, name, planned_payment, next_due,
    direction="borrowed", principal=100_000, currency="USD",
):
    loan = Loan(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, direction=direction,
        principal_minor=principal, currency=currency,
        planned_payment_minor=planned_payment, next_due=next_due,
    )
    db.add(loan)
    await db.flush()
    return loan


async def _budget(db, ws_id, *, name, amount, period="monthly", currency="USD", category_id=None):
    budget = Budget(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, period=period,
        amount_minor=amount, currency=currency, category_id=category_id,
    )
    db.add(budget)
    await db.flush()
    return budget


async def test_upcoming_due_merges_sorted_within_horizon(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")

    salary = await _scheduled(
        db, ws_id, acc, description="Salary", amount=300_000, next_due=TODAY,  # exactly today
    )
    netflix = await _subscription(
        db, ws_id, name="Netflix", amount=-999, next_renewal=TODAY + timedelta(days=2),
    )
    rent = await _scheduled(
        db, ws_id, acc, description="Rent", amount=-150_000, next_due=TODAY + timedelta(days=5),
    )
    car = await _due_loan(
        db, ws_id, name="Car", planned_payment=50_000, next_due=TODAY + timedelta(days=5),
        direction="borrowed",
    )
    insurance = await _scheduled(  # exactly on the horizon (today + 30) -> included
        db, ws_id, acc, description="Insurance", amount=-40_000, next_due=TODAY + timedelta(days=30),
    )
    # excluded: beyond the horizon, and a past-due item (< today)
    await _scheduled(db, ws_id, acc, description="TooFar", amount=-1, next_due=TODAY + timedelta(days=31))
    await _subscription(db, ws_id, name="OldSub", amount=-1, next_renewal=TODAY - timedelta(days=1))

    result = await AnalyticsService(db).upcoming(ws_id, today=TODAY)

    due = result["due"]
    # soonest-first; same-day (rent/car on +5) stable-tiebroken by kind (planned<loan)
    assert [d["label"] for d in due] == ["Salary", "Netflix", "Rent", "Car", "Insurance"]
    assert due[0] == {
        "kind": "planned", "id": salary.id, "label": "Salary",
        "due_on": TODAY, "amount_minor": 300_000, "currency": "USD",
    }
    assert due[1] == {
        "kind": "subscription", "id": netflix.id, "label": "Netflix",
        "due_on": TODAY + timedelta(days=2), "amount_minor": -999, "currency": "USD",
    }
    assert due[2]["id"] == rent.id and due[2]["kind"] == "planned"
    # loan rows carry a direction and the planned-payment amount
    assert due[3] == {
        "kind": "loan", "id": car.id, "label": "Car",
        "due_on": TODAY + timedelta(days=5), "amount_minor": 50_000,
        "currency": "USD", "direction": "borrowed",
    }
    assert due[4]["id"] == insurance.id
    assert result["over_budget"] == []


async def test_upcoming_excludes_inactive_canceled_and_null_due(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    # all in-horizon, but each individually excluded
    await _scheduled(
        db, ws_id, acc, description="Paused", amount=-1, next_due=TODAY + timedelta(days=3),
        is_active=False,
    )
    await _subscription(
        db, ws_id, name="Gone", amount=-1, next_renewal=TODAY + timedelta(days=3), status="canceled",
    )
    # a loan with no next_due date is not surfaced
    await _due_loan(db, ws_id, name="Undated", planned_payment=1_000, next_due=None)

    result = await AnalyticsService(db).upcoming(ws_id, today=TODAY)
    assert result["due"] == []


async def test_upcoming_caps_merged_list_at_limit(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    for i in range(1, 11):  # 10 subs due on consecutive days within the horizon
        await _subscription(
            db, ws_id, name=f"S{i:02d}", amount=-100, next_renewal=TODAY + timedelta(days=i),
        )

    result = await AnalyticsService(db).upcoming(ws_id, today=TODAY, limit=3)

    due = result["due"]
    assert len(due) == 3  # the three soonest survive the cap
    assert [d["label"] for d in due] == ["S01", "S02", "S03"]


async def test_upcoming_over_budget_lists_only_over_in_window(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    groceries = await _category(db, ws_id, name="AnGroceries")
    dining = await _category(db, ws_id, name="AnDining")

    # groceries budget 10_000; spend 12_000 this window -> over by 2_000
    await _budget(db, ws_id, name="Groceries", amount=10_000, category_id=groceries.id)
    await _tx(db, ws_id, acc, amount=-12_000, on=TODAY, category_id=groceries.id)
    # dining budget 10_000; spend only 3_000 -> within budget, excluded
    await _budget(db, ws_id, name="Dining", amount=10_000, category_id=dining.id)
    await _tx(db, ws_id, acc, amount=-3_000, on=TODAY, category_id=dining.id)
    # a category-less budget has no actual to compare -> excluded
    await _budget(db, ws_id, name="Misc", amount=1, category_id=None)

    result = await AnalyticsService(db).upcoming(ws_id, today=TODAY)

    assert result["over_budget"] == [
        {
            "budget_id": (await _first_budget_id(db, ws_id, groceries.id)),
            "label": "AnGroceries", "amount_minor": 10_000,
            "actual_minor": 12_000, "over_minor": 2_000, "currency": "USD",
        }
    ]


async def _first_budget_id(db, ws_id, category_id):
    return await db.scalar(
        sa.select(Budget.id).where(Budget.workspace_id == ws_id, Budget.category_id == category_id)
    )


async def test_upcoming_over_budget_spend_outside_window_not_counted(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    cat = await _category(db, ws_id, name="AnGroceries")
    await _budget(db, ws_id, name="Groceries", amount=10_000, category_id=cat.id)
    # a big expense in a PRIOR month is outside the monthly window containing today
    await _tx(db, ws_id, acc, amount=-99_000, on=date(2026, 8, 15), category_id=cat.id)

    result = await AnalyticsService(db).upcoming(ws_id, today=TODAY)
    assert result["over_budget"] == []


async def test_upcoming_preserves_per_item_currency(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    eur_acc = await _account(db, ws_id, currency="EUR", name="E")
    await _scheduled(
        db, ws_id, eur_acc, description="EurRent", amount=-100, next_due=TODAY + timedelta(days=1),
        currency="EUR",
    )
    await _subscription(
        db, ws_id, name="UsdSub", amount=-200, next_renewal=TODAY + timedelta(days=2), currency="USD",
    )

    result = await AnalyticsService(db).upcoming(ws_id, today=TODAY)
    by_label = {d["label"]: d["currency"] for d in result["due"]}
    assert by_label == {"EurRent": "EUR", "UsdSub": "USD"}


async def test_upcoming_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    await _scheduled(db, ws_id, acc, description="Mine", amount=-1, next_due=TODAY + timedelta(days=1))

    other_ws = await _other_workspace(db, user_factory)
    other_acc = await _account(db, other_ws.id, currency="USD", name="X")
    await _scheduled(
        db, other_ws.id, other_acc, description="Theirs", amount=-1, next_due=TODAY + timedelta(days=1),
    )

    result = await AnalyticsService(db).upcoming(ws_id, today=TODAY)
    assert [d["label"] for d in result["due"]] == ["Mine"]


async def test_upcoming_endpoint_returns_due_and_over_budget(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    cat = await _category(db, ws_id, name="AnGroceries")
    await _budget(db, ws_id, name="Groceries", amount=10_000, category_id=cat.id)
    await _tx(db, ws_id, acc, amount=-12_000, on=_today_utc(), category_id=cat.id)
    await _subscription(
        db, ws_id, name="Netflix", amount=-999, next_renewal=_today_utc() + timedelta(days=3),
    )
    await db.commit()  # the request runs in its own session
    h = await _auth(client)

    resp = await client.get("/api/v1/analytics/upcoming", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert [d["label"] for d in body["due"]] == ["Netflix"]
    assert body["due"][0]["kind"] == "subscription"
    assert body["over_budget"][0]["label"] == "AnGroceries"
    assert body["over_budget"][0]["over_minor"] == 2_000


def _today_utc():
    return datetime.now(UTC).date()
