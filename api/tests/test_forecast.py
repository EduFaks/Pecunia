import uuid
from datetime import date

import sqlalchemy as sa

from pecunia.models import (
    Account,
    Loan,
    ScheduledTransaction,
    Subscription,
    Transaction,
    Workspace,
    WorkspaceMembership,
)
from pecunia.services.forecast import ForecastService

TODAY = date(2026, 9, 13)


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


async def _tx(db, ws_id, account, *, amount, on, currency="USD"):
    tx = Transaction(
        id=uuid.uuid4(), workspace_id=ws_id, account_id=account.id,
        amount_minor=amount, currency=currency, description="t", occurred_on=on,
    )
    db.add(tx)
    await db.flush()
    return tx


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


async def _subscription(
    db, ws_id, *, name, amount, next_renewal, currency="USD",
    status="active", billing_frequency="monthly",
):
    sub = Subscription(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, amount_minor=amount,
        currency=currency, billing_frequency=billing_frequency,
        next_renewal=next_renewal, status=status,
    )
    db.add(sub)
    await db.flush()
    return sub


async def _loan(
    db, ws_id, *, name="Loan", direction="borrowed", principal, currency="USD",
    planned_payment=None, payment_frequency=None, next_due=None,
):
    loan = Loan(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, direction=direction,
        principal_minor=principal, currency=currency,
        planned_payment_minor=planned_payment, payment_frequency=payment_frequency,
        next_due=next_due,
    )
    db.add(loan)
    await db.flush()
    return loan


async def _other_workspace(db, user_factory):
    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    return other_ws


async def test_forecast_places_recurring_income_and_subscription_in_the_right_months(
    db, initialized_instance,
):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=50_000, next_due=date(2026, 10, 1),
    )
    await _subscription(db, ws_id, name="Netflix", amount=1_000, next_renewal=date(2026, 10, 5))

    result = await ForecastService(db).forecast(ws_id, today=TODAY, months=3)

    usd_cash = result["USD"]["cash"]
    usd_nw = result["USD"]["net_worth"]
    assert [p["date"] for p in usd_cash] == [
        date(2026, 10, 31), date(2026, 11, 30), date(2026, 12, 31),
    ]
    # Each month: +50_000 salary, -1_000 subscription -> +49_000 cumulative.
    assert [p["value_minor"] for p in usd_cash] == [149_000, 198_000, 247_000]
    # net worth starts at 100_000 (cash only, no assets/loans) and moves the
    # same way cash does here (no loan in this fixture to diverge them).
    assert [p["value_minor"] for p in usd_nw] == [149_000, 198_000, 247_000]
    assert all(p["projected"] is True for p in usd_cash + usd_nw)


async def test_forecast_per_currency_isolation(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    usd_acc = await _account(db, ws_id, currency="USD", initial=10_000, name="USD")
    await _account(db, ws_id, currency="EUR", initial=20_000, name="EUR")
    await _scheduled(
        db, ws_id, usd_acc, description="UsdIncome", amount=5_000, next_due=date(2026, 10, 1),
        currency="USD",
    )
    await _subscription(
        db, ws_id, name="EurSub", amount=2_000, next_renewal=date(2026, 10, 1), currency="EUR",
    )

    result = await ForecastService(db).forecast(ws_id, today=TODAY, months=1)

    # The USD schedule never moves EUR figures and vice versa.
    assert result["USD"]["cash"][0]["value_minor"] == 15_000
    assert result["EUR"]["cash"][0]["value_minor"] == 18_000
    assert result["USD"]["net_worth"][0]["value_minor"] == 15_000
    assert result["EUR"]["net_worth"][0]["value_minor"] == 18_000


async def test_forecast_loan_payment_lowers_cash_but_not_net_worth(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=100_000)
    await _loan(
        db, ws_id, principal=50_000, planned_payment=5_000,
        payment_frequency="monthly", next_due=date(2026, 10, 10),
    )

    result = await ForecastService(db).forecast(ws_id, today=TODAY, months=1)

    # Cash drops by the payment; net worth (cash 100_000 - debt 50_000 = 50_000
    # at start) is unaffected by the loan payment itself.
    assert result["USD"]["cash"][0]["value_minor"] == 95_000
    assert result["USD"]["net_worth"][0]["value_minor"] == 50_000


async def test_forecast_band_widens_with_distance(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=0)
    # 3 months of USD 6_000 expense history in the 6-month lookback window
    # (today = 2026-09-13); the other 3 months have none -> avg = 3_000/mo.
    await _tx(db, ws_id, acc, amount=-6_000, on=date(2026, 6, 5))
    await _tx(db, ws_id, acc, amount=-6_000, on=date(2026, 7, 5))
    await _tx(db, ws_id, acc, amount=-6_000, on=date(2026, 8, 5))

    result = await ForecastService(db).forecast(ws_id, today=TODAY, months=3)

    cash = result["USD"]["cash"]
    widths = [p["upper_minor"] - p["lower_minor"] for p in cash]
    # Width = 2 * avg * month_index (avg=3_000) -> 6_000, 12_000, 18_000.
    assert widths == [6_000, 12_000, 18_000]
    for i, p in enumerate(cash):
        half = widths[i] // 2
        assert p["lower_minor"] == p["value_minor"] - half
        assert p["upper_minor"] == p["value_minor"] + half


async def test_forecast_no_history_has_zero_band(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=1_000)

    result = await ForecastService(db).forecast(ws_id, today=TODAY, months=2)

    for p in result["USD"]["cash"]:
        assert p["lower_minor"] == p["upper_minor"] == p["value_minor"]


async def test_forecast_inactive_scheduled_transaction_is_excluded(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=1_000)
    st = await _scheduled(
        db, ws_id, acc, description="Paused", amount=9_999, next_due=date(2026, 10, 1),
    )
    st.is_active = False
    await db.flush()

    result = await ForecastService(db).forecast(ws_id, today=TODAY, months=1)

    assert result["USD"]["cash"][0]["value_minor"] == 1_000


async def test_forecast_months_defaults_to_six_points(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=0)

    result = await ForecastService(db).forecast(ws_id, today=TODAY)

    assert len(result["USD"]["cash"]) == 6
    assert len(result["USD"]["net_worth"]) == 6


async def test_forecast_months_clamps_to_one_and_twenty_four(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=0)

    svc = ForecastService(db)
    assert len((await svc.forecast(ws_id, today=TODAY, months=0))["USD"]["cash"]) == 1
    assert len((await svc.forecast(ws_id, today=TODAY, months=999))["USD"]["cash"]) == 24


async def test_forecast_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=1_000)

    other_ws = await _other_workspace(db, user_factory)
    other_acc = await _account(db, other_ws.id, currency="USD", initial=999_000, name="Other")
    await _scheduled(
        db, other_ws.id, other_acc, description="Theirs", amount=1_000, next_due=date(2026, 10, 1),
    )

    result = await ForecastService(db).forecast(ws_id, today=TODAY, months=1)

    assert result["USD"]["cash"][0]["value_minor"] == 1_000
