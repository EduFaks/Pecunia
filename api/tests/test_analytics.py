import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import sqlalchemy as sa

from pecunia.models import (
    Account,
    Asset,
    AssetValuation,
    Budget,
    Category,
    Contact,
    Holding,
    HoldingPrice,
    Loan,
    LoanPayment,
    NetWorthSnapshot,
    Portfolio,
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


async def test_net_worth_series_reconstructs_history_from_dated_asset_no_transactions(
    db, initialized_instance
):
    """The bug fix: a workspace with NO transactions and no persisted
    snapshots, but a dated asset valuation from a prior month, must still show
    that history on the series — not an empty/flat line. Reconstructed exactly
    like net_worth_composition (SnapshotService.net_worth_as_of per month)."""
    ws_id = await _ws_id(db, initialized_instance)
    assert await db.scalar(sa.select(sa.func.count()).select_from(NetWorthSnapshot)) == 0
    asset = Asset(id=uuid.uuid4(), workspace_id=ws_id, name="Watch", type="watch", currency="USD")
    db.add(asset)
    await db.flush()
    db.add(AssetValuation(
        id=uuid.uuid4(), workspace_id=ws_id, asset_id=asset.id,
        value_minor=50_000, as_of=date(2026, 3, 10),
    ))
    await db.flush()

    result = await AnalyticsService(db).net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 4, 30)
    )

    # never captured — this reconstruction doesn't touch net_worth_snapshots
    assert await db.scalar(sa.select(sa.func.count()).select_from(NetWorthSnapshot)) == 0
    usd = result["USD"]
    assert [r["date"] for r in usd] == [
        date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30),
    ]
    # before the valuation: 0, not flat/empty; from the valuation month on: 50_000
    assert [r["net_worth_minor"] for r in usd] == [0, 0, 50_000, 50_000]


async def test_net_worth_series_reconstructs_history_from_dated_loan_no_transactions(
    db, initialized_instance
):
    """Same bug, a loan this time: a borrowed loan opened in a prior month (no
    transactions at all) must show up as a negative net-worth history point
    from that month on."""
    ws_id = await _ws_id(db, initialized_instance)
    await _loan(db, ws_id, direction="borrowed", principal=30_000)

    result = await AnalyticsService(db).net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 2, 28)
    )

    assert result["USD"] == [
        {"date": date(2026, 1, 31), "net_worth_minor": -30_000},
        {"date": date(2026, 2, 28), "net_worth_minor": -30_000},
    ]


async def test_net_worth_series_matches_composition_totals(db, initialized_instance):
    """Each series point is the sum of the same month's composition parts —
    the two endpoints can never drift apart."""
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
    svc = AnalyticsService(db)
    window = {"from_date": date(2026, 1, 1), "to_date": date(2026, 4, 30)}

    series = await svc.net_worth_series(ws_id, **window)
    composition = await svc.net_worth_composition(ws_id, **window)

    assert [p["date"] for p in series["USD"]] == [c["period_start"] for c in composition["USD"]]
    for point, parts in zip(series["USD"], composition["USD"], strict=True):
        total = parts["cash_minor"] + parts["assets_minor"] + parts["investments_minor"] + parts["debts_minor"]
        assert point["net_worth_minor"] == total


async def test_net_worth_series_per_currency_and_workspace_scoped(
    db, initialized_instance, user_factory
):
    ws_id = await _ws_id(db, initialized_instance)
    usd = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, usd, amount=10_000, on=date(2026, 1, 15))
    eur_asset = await _asset_with_valuation(db, ws_id)  # EUR 40_000 as_of 2026-04-01

    other_ws = await _other_workspace(db, user_factory)
    other_acc = await _account(db, other_ws.id, currency="USD", initial=999_000)

    result = await AnalyticsService(db).net_worth_series(
        ws_id, from_date=date(2026, 1, 1), to_date=date(2026, 4, 30)
    )

    assert set(result) == {"USD", "EUR"}
    assert all(p["net_worth_minor"] == 110_000 for p in result["USD"])  # not 1_109_000
    eur = result["EUR"]
    assert eur[0]["net_worth_minor"] == 0  # before 2026-04-01
    assert eur[-1]["net_worth_minor"] == 40_000  # on/after 2026-04-01
    assert eur_asset and other_acc  # referenced


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


# ------------------------------------------------ earliest activity / all-time range


async def test_earliest_activity_date_min_across_sources(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    await _tx(db, ws_id, acc, amount=1_000, on=date(2025, 6, 1))

    asset = Asset(id=uuid.uuid4(), workspace_id=ws_id, name="A", type="other", currency="USD")
    db.add(asset)
    await db.flush()
    db.add(AssetValuation(
        id=uuid.uuid4(), workspace_id=ws_id, asset_id=asset.id,
        value_minor=1_000, as_of=date(2024, 3, 1),
    ))

    portfolio = Portfolio(id=uuid.uuid4(), workspace_id=ws_id, name="P", currency="USD")
    db.add(portfolio)
    await db.flush()
    holding = Holding(
        id=uuid.uuid4(), workspace_id=ws_id, portfolio_id=portfolio.id,
        name="H", quantity=Decimal(1),
    )
    db.add(holding)
    await db.flush()
    db.add(HoldingPrice(
        id=uuid.uuid4(), workspace_id=ws_id, holding_id=holding.id,
        unit_price_minor=100, as_of=date(2024, 6, 1),
    ))

    loan = await _loan(db, ws_id, direction="borrowed", principal=5_000)
    loan.opened_on = date(2023, 5, 1)  # the earliest of all the sources here
    db.add(LoanPayment(
        id=uuid.uuid4(), workspace_id=ws_id, loan_id=loan.id,
        amount_minor=100, paid_on=date(2025, 1, 1),
    ))

    db.add(Subscription(
        id=uuid.uuid4(), workspace_id=ws_id, name="Netflix", amount_minor=1_000, currency="USD",
        billing_frequency="monthly", next_renewal=date(2026, 10, 1), started_on=date(2024, 1, 1),
    ))
    await db.flush()

    result = await AnalyticsService(db).earliest_activity_date(ws_id, today=date(2026, 9, 13))
    assert result == date(2023, 5, 1)


async def test_earliest_activity_date_falls_back_to_today_when_empty(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    result = await AnalyticsService(db).earliest_activity_date(ws_id, today=date(2026, 9, 13))
    assert result == date(2026, 9, 13)


async def test_earliest_activity_date_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    other_ws = await _other_workspace(db, user_factory)
    other_acc = await _account(db, other_ws.id, currency="USD")
    await _tx(db, other_ws.id, other_acc, amount=1_000, on=date(2020, 1, 1))

    result = await AnalyticsService(db).earliest_activity_date(ws_id, today=date(2026, 9, 13))
    assert result == date(2026, 9, 13)  # the other workspace's ancient tx must not leak in
    assert other_acc


async def test_all_true_extends_spending_by_category_to_earliest_activity(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    cat = await _category(db, ws_id, name="AnOld", color="#22d3ee")
    old_date = date(2024, 10, 5)  # well outside the rolling 12-month default ending 2026-09-30
    await _tx(db, ws_id, acc, amount=-1_000, on=old_date, category_id=cat.id)
    await db.commit()
    h = await _auth(client)

    default_resp = await client.get(
        "/api/v1/analytics/spending-by-category", params={"to": "2026-09-30"}, headers=h,
    )
    all_resp = await client.get(
        "/api/v1/analytics/spending-by-category",
        params={"to": "2026-09-30", "all": "true"}, headers=h,
    )

    assert default_resp.status_code == all_resp.status_code == 200
    assert default_resp.json() == {}  # the old expense falls outside the default window
    assert all_resp.json()["USD"] == [
        {"category_id": str(cat.id), "name": "AnOld", "color": "#22d3ee", "spend_minor": 1_000}
    ]


async def test_all_true_extends_composition_range_to_earliest_activity(client, db, initialized_instance):
    """A valuation ~20 months before `to` is invisible on the rolling 12-month
    default axis (it never reaches back that far) but the composition's
    month axis extends all the way to it once `all=true` is set."""
    ws_id = await _ws_id(db, initialized_instance)
    asset = Asset(id=uuid.uuid4(), workspace_id=ws_id, name="Old asset", type="other", currency="USD")
    db.add(asset)
    await db.flush()
    old_valuation = date(2024, 12, 15)
    db.add(AssetValuation(
        id=uuid.uuid4(), workspace_id=ws_id, asset_id=asset.id,
        value_minor=5_000, as_of=old_valuation,
    ))
    await db.commit()
    h = await _auth(client)

    default_resp = await client.get(
        "/api/v1/analytics/net-worth-composition", params={"to": "2026-09-30"}, headers=h,
    )
    all_resp = await client.get(
        "/api/v1/analytics/net-worth-composition",
        params={"to": "2026-09-30", "all": "true"}, headers=h,
    )

    valuation_month_end = "2024-12-31"  # month_end(old_valuation)
    default_periods = [p["period_start"] for p in default_resp.json()["USD"]]
    all_periods = [p["period_start"] for p in all_resp.json()["USD"]]
    assert len(default_periods) == 12  # the ordinary rolling 12-month axis
    assert valuation_month_end not in default_periods  # too far back for the default window
    assert len(all_periods) > 12  # the axis now reaches back to the valuation's month
    assert valuation_month_end in all_periods


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


async def test_net_worth_endpoint_reconstructs_without_persisting(client, db, initialized_instance):
    """The endpoint reconstructs the series on the fly (same as
    net-worth-composition) — it no longer writes to net_worth_snapshots."""
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 1, 15))
    await db.commit()
    h = await _auth(client)

    resp = await client.get(
        "/api/v1/analytics/net-worth",
        params={"from": "2026-01-01", "to": "2026-01-31"}, headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["USD"][-1] == {"date": "2026-01-31", "net_worth_minor": 110_000}

    count = await db.scalar(
        sa.select(sa.func.count()).select_from(NetWorthSnapshot).where(
            NetWorthSnapshot.workspace_id == ws_id
        )
    )
    assert count == 0


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
    direction="borrowed", principal=100_000, currency="USD", payment_frequency=None,
):
    loan = Loan(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, direction=direction,
        principal_minor=principal, currency=currency,
        planned_payment_minor=planned_payment, next_due=next_due,
        payment_frequency=payment_frequency,
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


# ---------------------------------------------------------------------- forecast


async def test_forecast_endpoint_returns_per_currency_cash_and_net_worth(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=10_000)
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=5_000,
        next_due=_today_utc() + timedelta(days=1),
    )
    await db.commit()  # the request runs in its own session
    h = await _auth(client)

    resp = await client.get("/api/v1/analytics/forecast", params={"months": 2}, headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) >= {"USD"}
    assert len(body["USD"]["cash"]) == 2
    assert len(body["USD"]["net_worth"]) == 2
    first = body["USD"]["cash"][0]
    assert first["projected"] is True
    assert {"date", "value_minor", "lower_minor", "upper_minor", "projected"} <= set(first)


async def test_forecast_endpoint_defaults_to_six_months(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD")
    await db.commit()
    h = await _auth(client)

    resp = await client.get("/api/v1/analytics/forecast", headers=h)
    assert resp.status_code == 200
    assert len(resp.json()["USD"]["cash"]) == 6


async def test_forecast_endpoint_rejects_months_outside_one_to_twenty_four(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD")
    await db.commit()
    h = await _auth(client)

    too_low = await client.get("/api/v1/analytics/forecast", params={"months": 0}, headers=h)
    too_high = await client.get("/api/v1/analytics/forecast", params={"months": 25}, headers=h)
    assert too_low.status_code == 422
    assert too_high.status_code == 422


# ----------------------------------------------------------------------- summary


async def test_summary_savings_rate_and_prior_month_trend(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    # Current month (Sep 2026): income 10_000, spend 4_000 -> saved 6_000, 60%.
    await _tx(db, ws_id, acc, amount=10_000, on=date(2026, 9, 5))
    await _tx(db, ws_id, acc, amount=-4_000, on=date(2026, 9, 10))
    # Prior month (Aug 2026): income 8_000, spend 8_000 -> saved 0, 0%.
    await _tx(db, ws_id, acc, amount=8_000, on=date(2026, 8, 5))
    await _tx(db, ws_id, acc, amount=-8_000, on=date(2026, 8, 10))

    result = await AnalyticsService(db).summary(ws_id, today=TODAY)

    assert result["USD"]["savings"] == {
        "income_minor": 10_000, "spend_minor": 4_000, "saved_minor": 6_000, "rate_bps": 6_000,
        "prev_saved_minor": 0, "prev_rate_bps": 0,
    }


async def test_summary_savings_rate_is_zero_when_income_is_zero(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    await _tx(db, ws_id, acc, amount=-5_000, on=date(2026, 9, 5))  # spend only, no income

    result = await AnalyticsService(db).summary(ws_id, today=TODAY)

    savings = result["USD"]["savings"]
    assert savings["income_minor"] == 0
    assert savings["saved_minor"] == -5_000
    assert savings["rate_bps"] == 0  # never a division by zero


async def test_summary_committed_monthly_normalizes_every_cycle(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD")
    # weekly 1_200 -> annual 62_400 -> monthly 5_200
    await _subscription(
        db, ws_id, name="Cleaner", amount=1_200, next_renewal=date(2026, 10, 1),
        billing_frequency="weekly",
    )
    # quarterly planned payment 9_000 -> annual 36_000 -> monthly 3_000
    await _due_loan(
        db, ws_id, name="Car", planned_payment=9_000, next_due=date(2026, 10, 10),
        payment_frequency="quarterly",
    )
    # yearly recurring expense 24_000 -> annual 24_000 -> monthly 2_000
    await _scheduled(
        db, ws_id, acc, description="Insurance", amount=-24_000, next_due=date(2026, 10, 1),
        frequency="yearly",
    )
    # recurring INCOME must never count as a committed cost
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=50_000, next_due=date(2026, 10, 1),
        frequency="monthly",
    )
    # a canceled subscription and an inactive schedule must never count
    await _subscription(
        db, ws_id, name="Gone", amount=99_999, next_renewal=date(2026, 10, 1), status="canceled",
    )
    await _scheduled(
        db, ws_id, acc, description="Paused", amount=-99_999, next_due=date(2026, 10, 1),
        is_active=False,
    )
    # a loan with a planned payment but no frequency can't be normalized -> skipped
    await _due_loan(db, ws_id, name="Undated", planned_payment=1_000, next_due=None)

    result = await AnalyticsService(db).summary(ws_id, today=TODAY)

    assert result["USD"]["committed_monthly"] == {
        "total_minor": 10_200, "subscriptions_minor": 5_200, "loans_minor": 3_000, "planned_minor": 2_000,
    }


async def test_summary_committed_monthly_loan_needs_next_due_too(db, initialized_instance):
    """L2 (filter parity): a loan with a `payment_frequency` and
    `planned_payment_minor` but no `next_due` isn't actually scheduled
    yet — it must be excluded from committed-monthly, same as the cash
    forecast's own loan-occurrence query (`ForecastService.forecast`),
    which already skips it (via `expand_occurrences` returning nothing for
    a null anchor date)."""
    ws_id = await _ws_id(db, initialized_instance)
    # An anchor item so "USD" appears in the result even though the loan
    # below is excluded.
    await _subscription(db, ws_id, name="Anchor", amount=1_000, next_renewal=date(2026, 10, 1))
    await _due_loan(
        db, ws_id, name="Someday", planned_payment=6_000, next_due=None,
        payment_frequency="monthly",
    )

    result = await AnalyticsService(db).summary(ws_id, today=TODAY)

    assert result["USD"]["committed_monthly"] == {
        "total_minor": 1_000, "subscriptions_minor": 1_000, "loans_minor": 0, "planned_minor": 0,
    }


async def test_summary_net_worth_change_delta_pct_and_top_movers(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    # cash: +20_000 after the start of the month
    await _tx(db, ws_id, acc, amount=20_000, on=date(2026, 9, 5))
    # assets: 0 -> 5_000 after the start of the month
    asset = Asset(id=uuid.uuid4(), workspace_id=ws_id, name="X", type="other", currency="USD")
    db.add(asset)
    await db.flush()
    db.add(AssetValuation(
        id=uuid.uuid4(), workspace_id=ws_id, asset_id=asset.id,
        value_minor=5_000, as_of=date(2026, 9, 10),
    ))
    # debts: a 30_000 loan, paid down 10_000 after the start of the month
    # (a shrinking liability is a +10_000 move for net worth).
    loan = await _loan(db, ws_id, direction="borrowed", principal=30_000)
    db.add(LoanPayment(
        id=uuid.uuid4(), workspace_id=ws_id, loan_id=loan.id,
        amount_minor=10_000, paid_on=date(2026, 9, 12),
    ))
    await db.flush()

    result = await AnalyticsService(db).summary(ws_id, today=TODAY)

    change = result["USD"]["net_worth_change"]
    # start of month (Sep 1): cash 100_000, assets 0, investments 0, debts -30_000 -> 70_000
    # now (Sep 13): cash 120_000, assets 5_000, investments 0, debts -20_000 -> 105_000
    assert change["start_of_month_minor"] == 70_000
    assert change["now_minor"] == 105_000
    assert change["delta_minor"] == 35_000
    assert change["pct_bps"] == 5_000  # 35_000 / 70_000 = 50.00%
    # ranked by |delta|: cash (+20_000), debts (+10_000), assets (+5_000);
    # investments never moved (0), so it's excluded, not just ranked last.
    assert change["movers"] == [
        {"label": "Cash", "delta_minor": 20_000},
        {"label": "Debts", "delta_minor": 10_000},
        {"label": "Assets", "delta_minor": 5_000},
    ]


async def test_summary_per_currency_isolation(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    usd_acc = await _account(db, ws_id, currency="USD", initial=10_000, name="USD")
    await _account(db, ws_id, currency="EUR", initial=20_000, name="EUR")
    await _subscription(
        db, ws_id, name="UsdSub", amount=1_000, next_renewal=date(2026, 10, 1), currency="USD",
    )
    await _subscription(
        db, ws_id, name="EurSub", amount=2_000, next_renewal=date(2026, 10, 1), currency="EUR",
    )
    await _tx(db, ws_id, usd_acc, amount=5_000, on=date(2026, 9, 5), currency="USD")

    result = await AnalyticsService(db).summary(ws_id, today=TODAY)

    assert result["USD"]["committed_monthly"]["subscriptions_minor"] == 1_000
    assert result["EUR"]["committed_monthly"]["subscriptions_minor"] == 2_000
    assert result["USD"]["savings"]["income_minor"] == 5_000
    # the EUR account had no transactions this/last month -> no EUR savings activity
    assert "EUR" not in result or result["EUR"]["savings"]["income_minor"] == 0


async def test_summary_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=1_000)

    other_ws = await _other_workspace(db, user_factory)
    other_acc = await _account(db, other_ws.id, currency="USD", initial=999_000, name="Other")
    await _subscription(
        db, other_ws.id, name="Theirs", amount=50_000, next_renewal=date(2026, 10, 1),
    )
    await _tx(db, other_ws.id, other_acc, amount=999_000, on=date(2026, 9, 5))

    result = await AnalyticsService(db).summary(ws_id, today=TODAY)

    assert result["USD"]["committed_monthly"]["subscriptions_minor"] == 0
    assert result["USD"]["net_worth_change"]["now_minor"] == 1_000


async def test_summary_endpoint_returns_per_currency_metrics(client, db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=10_000)
    await _tx(db, ws_id, acc, amount=5_000, on=_today_utc())
    await db.commit()  # the request runs in its own session
    h = await _auth(client)

    resp = await client.get("/api/v1/analytics/summary", headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert "USD" in body
    usd = body["USD"]
    assert {"savings", "committed_monthly", "net_worth_change"} <= set(usd)
    assert usd["savings"]["income_minor"] == 5_000
    assert usd["net_worth_change"]["now_minor"] == 15_000
