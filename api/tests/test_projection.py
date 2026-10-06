import uuid
from datetime import date

import sqlalchemy as sa

from pecunia.models import (
    Account,
    BankAccountLink,
    BankConnection,
    Loan,
    ScheduledTransaction,
    Subscription,
    Transaction,
    Workspace,
    WorkspaceMembership,
)
from pecunia.period import month_end, shift_month
from pecunia.services.projection import ProjectionService
from pecunia.services.transfers import TransferService

TODAY = date(2026, 9, 13)


async def _ws_id(db, initialized_instance):
    return await db.scalar(
        sa.select(WorkspaceMembership.workspace_id).where(
            WorkspaceMembership.user_id == initialized_instance["user"].id
        )
    )


async def _account(db, ws_id, *, currency="USD", initial=0, name="Acc", type="checking"):
    acc = Account(
        id=uuid.uuid4(), workspace_id=ws_id, name=name, type=type,
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
    db, ws_id, account, *, description, amount, next_due,
    currency="USD", frequency="monthly", is_active=True,
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


async def _loan(
    db, ws_id, *, name="Loan", direction="borrowed", principal=100_000, currency="USD",
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


async def _card_account(db, ws_id, *, currency="USD", name="Card"):
    return await _account(db, ws_id, currency=currency, name=name, type="credit_card")


async def _card_link(
    db, ws_id, account, *, provider_balance_minor, bill_due_date,
    pluggy_item_id=None, pluggy_account_id=None,
):
    pluggy_item_id = pluggy_item_id or f"item-{uuid.uuid4()}"
    pluggy_account_id = pluggy_account_id or f"acc-{uuid.uuid4()}"
    connection = BankConnection(
        id=uuid.uuid4(), workspace_id=ws_id, pluggy_item_id=pluggy_item_id,
        institution_name="Bank", status="ok",
    )
    db.add(connection)
    await db.flush()
    link = BankAccountLink(
        id=uuid.uuid4(), workspace_id=ws_id, connection_id=connection.id,
        account_id=account.id, pluggy_account_id=pluggy_account_id,
        sync_from=date(2026, 1, 1),
        provider_balance_minor=provider_balance_minor,
        bill_due_date=bill_due_date,
    )
    db.add(link)
    await db.flush()
    return link


async def _other_workspace(db, user_factory):
    other = await user_factory(email="other@example.com")
    other_ws = Workspace(id=uuid.uuid4(), name="Other")
    db.add(other_ws)
    await db.flush()
    db.add(WorkspaceMembership(workspace_id=other_ws.id, user_id=other.id, role="owner"))
    return other_ws


# --------------------------------------------------------------------------- #
# Components sum to the net month delta
# --------------------------------------------------------------------------- #


async def test_projection_components_sum_to_optimistic_delta_each_month(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=100_000)
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=50_000, next_due=date(2026, 10, 1),
    )
    await _subscription(db, ws_id, name="Netflix", amount=5_000, next_renewal=date(2026, 10, 5))
    # A recurring scheduled EXPENSE folds into the same subscriptions_minor
    # bucket (no separate component key) — mirrors committed_monthly's grouping.
    await _scheduled(
        db, ws_id, acc, description="Gym", amount=-2_000, next_due=date(2026, 10, 7),
    )
    await _loan(
        db, ws_id, principal=50_000, planned_payment=3_000,
        payment_frequency="monthly", next_due=date(2026, 10, 10),
    )

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=3)
    points = result["USD"]["points"]

    assert len(points) == 3
    assert points[0]["components"] == {
        "income_minor": 50_000,
        "subscriptions_minor": 7_000,  # 5_000 subscription + 2_000 recurring expense
        "loans_minor": 3_000,
        "card_bills_minor": 0,
        "variable_minor": 0,  # no transaction history -> band average is 0
    }

    prev = 100_000
    for p in points:
        c = p["components"]
        delta = c["income_minor"] - c["subscriptions_minor"] - c["loans_minor"] - c["card_bills_minor"]
        assert p["optimistic_minor"] - prev == delta
        # band average is 0 here -> realistic must equal optimistic exactly
        assert p["realistic_minor"] == p["optimistic_minor"]
        prev = p["optimistic_minor"]

    assert points[-1]["optimistic_minor"] == 100_000 + 3 * 40_000


# --------------------------------------------------------------------------- #
# Card bills: rolled-due month, once per card, lowers both lines, labeled
# --------------------------------------------------------------------------- #


async def test_card_bill_lands_once_in_rolled_due_month_and_lowers_both_lines(
    db, initialized_instance,
):
    ws_id = await _ws_id(db, initialized_instance)
    card_a = await _card_account(db, ws_id, currency="USD", name="Visa")
    card_b = await _card_account(db, ws_id, currency="USD", name="Amex")
    # bill_due_date day-of-month 20 -> next_due_on_or_after(.., TODAY=Sep 13)
    # rolls to Sep 20 (this month), which still buckets into the FIRST
    # projected month (Oct 31) — the next bill due can never be more than
    # ~1 month out, so it always lands in month index 0.
    await _card_link(db, ws_id, card_a, provider_balance_minor=-130_000, bill_due_date=date(2026, 8, 20))
    await _card_link(db, ws_id, card_b, provider_balance_minor=-20_000, bill_due_date=date(2026, 8, 20))

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=2)
    points = result["USD"]["points"]

    assert points[0]["components"]["card_bills_minor"] == 150_000
    assert points[1]["components"]["card_bills_minor"] == 0  # counted once, not repeated
    labels = {lbl["label"]: lbl["amount_minor"] for lbl in points[0]["card_bill_labels"]}
    assert labels == {"Visa": 130_000, "Amex": 20_000}
    assert points[1]["card_bill_labels"] == []

    # Both lines lowered by the full combined bill (no transaction history ->
    # band average 0, so realistic == optimistic here).
    assert points[0]["optimistic_minor"] == -150_000
    assert points[0]["realistic_minor"] == -150_000
    assert points[1]["optimistic_minor"] == -150_000  # no further deltas


async def test_card_spend_mtd_excludes_transfer_legs(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    card = await _card_account(db, ws_id, currency="USD")
    savings = await _account(db, ws_id, currency="USD", name="Savings")
    await _card_link(db, ws_id, card, provider_balance_minor=-1_300_000, bill_due_date=date(2026, 8, 20))
    # A real card expense this month -> reduces the bill (card_spend_mtd).
    await _tx(db, ws_id, card, amount=-20_000, on=date(2026, 9, 10))
    # A transfer OUT of the card this month -> its card-side leg carries a
    # transfer_id and must NOT reduce the bill (the money-critical fix).
    await TransferService(db).create(
        ws_id, from_account_id=card.id, to_account_id=savings.id,
        amount_minor=50_000, currency="USD", description="Card payment",
        occurred_on=date(2026, 9, 12),
    )

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=1)

    # Without the fix this would be 1_300_000 - 70_000 = 1_230_000.
    assert result["USD"]["points"][0]["components"]["card_bills_minor"] == 1_300_000 - 20_000


# --------------------------------------------------------------------------- #
# realistic <= optimistic; equal when the variable band is 0
# --------------------------------------------------------------------------- #


async def test_realistic_lowers_below_optimistic_by_cumulative_variable_band(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=0)
    # 3 months of 9_000 expense history in the 6-month lookback -> avg total
    # monthly spend = 27_000 / 6 = 4_500; no committed costs to subtract.
    await _tx(db, ws_id, acc, amount=-9_000, on=date(2026, 6, 5))
    await _tx(db, ws_id, acc, amount=-9_000, on=date(2026, 7, 5))
    await _tx(db, ws_id, acc, amount=-9_000, on=date(2026, 8, 5))

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=3)
    points = result["USD"]["points"]

    assert [p["components"]["variable_minor"] for p in points] == [4_500, 4_500, 4_500]
    # start = AccountService.balance = 0 initial - 27_000 (the same history
    # used to size the band) -> optimistic has no further deltas to apply.
    assert [p["optimistic_minor"] for p in points] == [-27_000, -27_000, -27_000]
    # realistic = optimistic - cumulative variable (4_500, 9_000, 13_500).
    assert [p["realistic_minor"] for p in points] == [-31_500, -36_000, -40_500]
    for p in points:
        assert p["realistic_minor"] <= p["optimistic_minor"]


# --------------------------------------------------------------------------- #
# A this-month deficit carries forward into later months (cumulative walk)
# --------------------------------------------------------------------------- #


async def test_deficit_carries_forward_and_never_recovers(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=50_000)
    card = await _card_account(db, ws_id, currency="USD")
    await _card_link(db, ws_id, card, provider_balance_minor=-130_000, bill_due_date=date(2026, 8, 20))
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=20_000, next_due=date(2026, 10, 1),
    )

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=2)
    out = result["USD"]
    points = out["points"]

    # Month 1: 50_000 start + 20_000 income - 130_000 card bill = -60_000.
    assert points[0]["optimistic_minor"] == -60_000
    # Month 2: no card bill this time, just +20_000 income -> the month-1
    # deficit is NOT reset, it carries forward cumulatively.
    assert points[1]["optimistic_minor"] == -40_000
    assert points[1]["optimistic_minor"] == points[0]["optimistic_minor"] + 20_000

    # Still negative at the end of the horizon -> never recovers.
    assert out["recovery"] is None
    assert out["runway_months"] == 1
    assert out["runway_until"] == points[0]["date"]


# --------------------------------------------------------------------------- #
# runway_months: None when always >= 0, correct 1-based index when it dips
# --------------------------------------------------------------------------- #


async def test_runway_none_when_realistic_never_negative(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=10_000)
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=1_000, next_due=date(2026, 10, 1),
    )

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=3)
    out = result["USD"]

    assert all(p["realistic_minor"] >= 0 for p in out["points"])
    assert out["runway_months"] is None
    assert out["runway_until"] is None
    assert out["recovery"] is None  # never negative -> nothing to recover from


async def test_runway_index_points_at_the_month_it_first_dips_negative(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=5_000)
    await _scheduled(
        db, ws_id, acc, description="Salary", amount=3_000, next_due=date(2026, 10, 1),
    )
    # A big recurring expense that only lands starting month 2 (Nov) within a
    # 2-month horizon (its next occurrence, Dec, falls outside the horizon).
    await _scheduled(
        db, ws_id, acc, description="BigBill", amount=-20_000, next_due=date(2026, 11, 5),
    )

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=2)
    out = result["USD"]
    points = out["points"]

    assert points[0]["optimistic_minor"] == 5_000 + 3_000  # month 1 untouched by BigBill
    assert points[1]["optimistic_minor"] == 8_000 + 3_000 - 20_000  # -9_000

    assert out["runway_months"] == 2
    assert out["runway_until"] == points[1]["date"]


# --------------------------------------------------------------------------- #
# lowest_point: value + date, seeded with today/start, earliest tie wins
# --------------------------------------------------------------------------- #


async def test_lowest_point_reports_value_and_earliest_date(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=1_000)
    card = await _card_account(db, ws_id, currency="USD")
    await _card_link(db, ws_id, card, provider_balance_minor=-5_000, bill_due_date=date(2026, 8, 20))

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=2)
    out = result["USD"]
    points = out["points"]

    # Month 1: 1_000 - 5_000 = -4_000; month 2: unchanged (-4_000) -> both
    # points tie for the minimum; the EARLIEST (month 1) wins the tie.
    assert points[0]["optimistic_minor"] == -4_000
    assert points[1]["optimistic_minor"] == -4_000
    assert out["lowest_point"] == {"value_minor": -4_000, "date": points[0]["date"]}


async def test_lowest_point_can_be_todays_start_when_nothing_dips_further(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=1_000)

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=2)
    out = result["USD"]

    # Nothing moves the balance at all -> every point equals the start; the
    # seeded today-point is a tie, so the lowest_point date is today itself
    # (the earliest in the seeded series).
    assert out["lowest_point"] == {"value_minor": 1_000, "date": TODAY}


# --------------------------------------------------------------------------- #
# recovery: detected after a dip; None when it never recovers or never dips
# --------------------------------------------------------------------------- #


async def test_recovery_detected_after_a_dip(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    acc = await _account(db, ws_id, currency="USD", initial=1_000)
    card = await _card_account(db, ws_id, currency="USD")
    await _card_link(db, ws_id, card, provider_balance_minor=-5_000, bill_due_date=date(2026, 8, 20))
    # A large income landing only in month 3 (Dec) flips the balance positive.
    await _scheduled(
        db, ws_id, acc, description="Bonus", amount=10_000, next_due=date(2026, 12, 1),
    )

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=3)
    out = result["USD"]
    points = out["points"]

    assert points[0]["optimistic_minor"] == -4_000  # dip
    assert points[1]["optimistic_minor"] == -4_000  # still negative
    assert points[2]["optimistic_minor"] == 6_000  # -4_000 + 10_000 -> recovered

    assert out["recovery"] == {"date": points[2]["date"], "value_minor": 6_000}


# --------------------------------------------------------------------------- #
# Per-currency isolation
# --------------------------------------------------------------------------- #


async def test_projection_per_currency_isolation(db, initialized_instance):
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

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=1)

    usd_point = result["USD"]["points"][0]
    eur_point = result["EUR"]["points"][0]
    assert usd_point["optimistic_minor"] == 15_000
    assert usd_point["components"]["subscriptions_minor"] == 0
    assert eur_point["optimistic_minor"] == 18_000
    assert eur_point["components"]["income_minor"] == 0
    assert result["USD"]["currency"] == "USD"
    assert result["EUR"]["currency"] == "EUR"


# --------------------------------------------------------------------------- #
# months clamp to 1..24
# --------------------------------------------------------------------------- #


async def test_months_clamps_to_one_and_twenty_four(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=0)

    svc = ProjectionService(db)
    assert len((await svc.project(ws_id, today=TODAY, months=0))["USD"]["points"]) == 1
    assert len((await svc.project(ws_id, today=TODAY, months=999))["USD"]["points"]) == 24


async def test_months_defaults_to_six_points(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=0)

    result = await ProjectionService(db).project(ws_id, today=TODAY)

    assert len(result["USD"]["points"]) == 6
    assert result["USD"]["variable_lookback_months"] == 6


# --------------------------------------------------------------------------- #
# Clock-free + workspace scoping
# --------------------------------------------------------------------------- #


async def test_projection_is_clock_free_point_dates_follow_today_param(db, initialized_instance):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=0)

    other_today = date(2027, 1, 15)
    result = await ProjectionService(db).project(ws_id, today=other_today, months=2)

    assert result["USD"]["points"][0]["date"] == month_end(shift_month(other_today, 1))
    assert result["USD"]["points"][1]["date"] == month_end(shift_month(other_today, 2))
    assert result["USD"]["lowest_point"]["date"] == other_today  # seeded with the passed-in today


async def test_projection_is_workspace_scoped(db, initialized_instance, user_factory):
    ws_id = await _ws_id(db, initialized_instance)
    await _account(db, ws_id, currency="USD", initial=1_000)

    other_ws = await _other_workspace(db, user_factory)
    other_acc = await _account(db, other_ws.id, currency="USD", initial=999_000, name="Other")
    await _scheduled(
        db, other_ws.id, other_acc, description="Theirs", amount=1_000, next_due=date(2026, 10, 1),
    )

    result = await ProjectionService(db).project(ws_id, today=TODAY, months=1)

    assert result["USD"]["points"][0]["optimistic_minor"] == 1_000
